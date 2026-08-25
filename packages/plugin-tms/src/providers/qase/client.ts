/**
 * The Qase TestOps v1 client — `fetch`, and nothing else.
 *
 * Not the generated `qase-api-client`: it is an OpenAPI-generated surface with its own runtime, and this
 * package needs eight endpoints. The three things a hand-written client must not get wrong are all here,
 * and all tested offline against a stub `fetch`:
 *
 * | Concern | What this does |
 * |---|---|
 * | Rate limits (1000/min per user, 3000/min per IP) | honours `Retry-After` on 429, backs off on 5xx, gives up after {@link MAX_ATTEMPTS} |
 * | Pagination | `limit`/`offset` walked to exhaustion by {@link QaseClient.list}, never a single unbounded page |
 * | Failure reporting | Qase's `{ status: false, errorMessage }` body becomes the message, so the user reads Qase's words rather than `HTTP 422` |
 *
 * A network error is fatal here on purpose: unlike the reporter — which must never turn a passing suite
 * red — the CLI's entire job is to talk to Qase, and pretending a failed sync succeeded is worse than
 * exiting non-zero.
 *
 * @example
 * const client = new QaseClient(readQaseConfig());
 * const cases = await client.list<{ id: number }>(`/case/${client.project}`);
 */
import { QASE_DEFAULT_BASE_URL, type QaseConfig } from './config.js';

/** Qase's envelope. `status: false` accompanies every 4xx/5xx, with the reason in `errorMessage`. */
interface QaseEnvelope<T> {
  status?: boolean;
  result?: T;
  errorMessage?: string;
  errorFields?: Array<{ field?: string; error?: string }>;
}

interface QasePage<T> {
  total?: number;
  filtered?: number;
  count?: number;
  entities?: T[];
}

export class QaseApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = 'QaseApiError';
    this.status = status;
    this.path = path;
  }
}

/** Four attempts covers a rate-limit window and a restart; more just delays a real failure. */
export const MAX_ATTEMPTS = 4;
/** Qase's own request timeout is 60 s, so waiting longer only hides a hang. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Qase caps `limit` at 100 for list endpoints. */
export const PAGE_SIZE = 100;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface QaseClientOptions {
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injected in tests so a backoff does not make the suite wait for real. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * How long to wait before attempt `n`. `Retry-After` wins when the server sends one — it is the only
 * number that reflects the actual window — otherwise 1 s, 2 s, 4 s with jitter so a fleet of CI shards
 * that hit the limit together do not retry in lockstep.
 */
export function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
  }
  return 2 ** (attempt - 1) * 1000 + Math.floor(Math.random() * 250);
}

export class QaseClient {
  readonly project: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: QaseConfig, options: QaseClientOptions = {}) {
    this.project = config.project;
    this.baseUrl = config.baseUrl === '' ? QASE_DEFAULT_BASE_URL : config.baseUrl;
    this.token = config.token;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const search = new URLSearchParams(
      Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]),
    ).toString();
    return this.request<T>('GET', search === '' ? path : `${path}?${search}`);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /**
   * Every entity behind a paginated endpoint. Walks `offset` until a page comes back short or the
   * reported total is reached — a client that reads page one and stops is the classic way a sync
   * "discovers" that half the suite is missing and helpfully recreates it.
   */
  async list<T>(path: string, query: Record<string, string | number> = {}): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.get<QasePage<T>>(path, { ...query, limit: PAGE_SIZE, offset });
      const entities = page.entities ?? [];
      all.push(...entities);
      const total = page.total ?? page.filtered;
      if (entities.length < PAGE_SIZE || (total !== undefined && all.length >= total)) {
        return all;
      }
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: QaseApiError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.doFetch(url, {
          method,
          headers: {
            Token: this.token,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // A transport failure (DNS, reset, timeout) is retryable in exactly the same way a 503 is.
        lastError = new QaseApiError(
          `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
          0,
          path,
        );
        if (attempt === MAX_ATTEMPTS) {
          throw lastError;
        }
        await this.sleep(backoffMs(attempt, null));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new QaseApiError(
          `${method} ${path} → HTTP ${response.status}`,
          response.status,
          path,
        );
        if (attempt === MAX_ATTEMPTS) {
          throw lastError;
        }
        await this.sleep(backoffMs(attempt, response.headers.get('Retry-After')));
        continue;
      }

      const envelope = (await response.json().catch(() => ({}))) as QaseEnvelope<T>;
      if (!response.ok || envelope.status === false) {
        throw new QaseApiError(
          describe(envelope, response.status, method, path),
          response.status,
          path,
        );
      }
      return envelope.result as T;
    }

    /* c8 ignore next */
    throw lastError ?? new QaseApiError(`${method} ${path} failed`, 0, path);
  }
}

/** Qase's own words when it gives them, plus the field-level detail that explains most 422s. */
function describe(
  envelope: QaseEnvelope<unknown>,
  status: number,
  method: string,
  path: string,
): string {
  const fields = (envelope.errorFields ?? [])
    .map(field => `${field.field ?? '?'}: ${field.error ?? '?'}`)
    .join('; ');
  const reason = envelope.errorMessage ?? `HTTP ${status}`;
  const hint =
    status === 401 || status === 403
      ? ' — check QASE_TESTOPS_API_TOKEN and that the token owner can reach this project'
      : '';
  return `${method} ${path} → ${reason}${fields === '' ? '' : ` (${fields})`}${hint}`;
}
