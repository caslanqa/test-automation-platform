/**
 * Talking to a model, without owning a transport.
 *
 * `@pwtap/plugin-ai-judge` is an **optional peer**, reached through a guarded `await import()`. A hard
 * dependency would put `@anthropic-ai/sdk` into every heal installation and into `nfr-check`'s runtime
 * closure, for a tier that is off by default.
 *
 * **What is reused, and what could not be.** `judgeFetch` (three attempts, transient set,
 * `Retry-After`, a fresh per-attempt deadline), the prefix routing (`local/`, `groq/`, `anthropic/`…),
 * the gateway endpoint table and the brace-balanced JSON extractor. All battle-tested, and reusing them
 * means one naming scheme and one set of URLs across the platform.
 *
 * What could **not** be reused is `AIProvider` itself, and the plan was wrong about this: it expected a
 * provider registered through `registerProvider` to serve the healer automatically. It cannot —
 * `AIProvider.judge` returns a `JudgeVerdict` (pass/score/reasoning), and a failure class is not one.
 * So the three wire formats are composed here against the endpoint table instead, which is why
 * `endpointForKind` was added to the judge plugin rather than a second URL table added here. A custom
 * provider serves the healer by passing an `endpoint` alongside itself.
 *
 * @example
 * const kit = await loadJudgeKit();
 * if (kit !== undefined) await askModel(kit, 'groq/llama-3.3-70b', system, user);
 */
import type { TriageReply } from './parse.js';
import { extractJsonObject as localExtract, parseTriageReply } from './parse.js';
import { REPAIR_HINT, TRIAGE_SCHEMA } from './prompt.js';

/** The slice of `@pwtap/plugin-ai-judge` this tier needs. Structural, so a minor bump cannot break it. */
export interface JudgeKit {
  judgeFetch: (
    label: string,
    url: string,
    init: RequestInit,
    attempts?: number,
  ) => Promise<Response>;
  kindForModel: (modelId: string) => string;
  stripPrefix: (modelId: string, kind: string) => string;
  endpointForKind: (kind: string) =>
    | {
        label: string;
        wire: 'openai' | 'ollama' | 'anthropic';
        baseUrl: () => string;
        apiKey: () => string | undefined;
      }
    | undefined;
  extractJsonObject: (raw: string) => string | undefined;
}

let announced = false;

/** Say a thing like this exactly once per process — a per-failure repeat would bury the report. */
function announce(message: string): void {
  if (!announced) {
    announced = true;
    process.stderr.write(`[heal] ${message}\n`);
  }
}

/**
 * Load the judge plugin's transport, or explain its absence once and return undefined.
 *
 * Never throws. Escalation is an optional improvement on a deterministic answer; a missing optional
 * peer must not change an exit code.
 */
/**
 * Held in a variable rather than written inline, so TypeScript does not resolve it.
 *
 * A literal `import('@pwtap/plugin-ai-judge')` makes the judge plugin's `.d.ts` a **build-time**
 * requirement of this package — which it is not: `JudgeKit` above is a structural copy precisely so the
 * two are decoupled, and the real check is `typeof kit.judgeFetch === 'function'` below. That accidental
 * coupling broke a release: `changeset publish` runs each package's `prepack` in parallel, every prepack
 * cleans its own `dist` first, and this package's `tsc -b` hit the window where the judge plugin's
 * declarations did not exist. `error TS2307`, and nine packages shipped without this one.
 *
 * Do not inline it back.
 */
const JUDGE_PACKAGE = '@pwtap/plugin-ai-judge';

export async function loadJudgeKit(): Promise<JudgeKit | undefined> {
  try {
    const kit = (await import(JUDGE_PACKAGE)) as Partial<JudgeKit>;
    if (
      typeof kit.judgeFetch !== 'function' ||
      typeof kit.endpointForKind !== 'function' ||
      typeof kit.kindForModel !== 'function' ||
      typeof kit.stripPrefix !== 'function'
    ) {
      announce(
        'escalation skipped — the installed @pwtap/plugin-ai-judge does not export the transport this needs (upgrade it)',
      );
      return undefined;
    }
    return {
      judgeFetch: kit.judgeFetch,
      kindForModel: kit.kindForModel,
      stripPrefix: kit.stripPrefix,
      endpointForKind: kit.endpointForKind,
      extractJsonObject: kit.extractJsonObject ?? localExtract,
    };
  } catch {
    announce(
      'escalation skipped — install @pwtap/plugin-ai-judge to enable it. Classification stays deterministic.',
    );
    return undefined;
  }
}

/** Which model to ask. `JUDGE_MODEL` is honoured last so a project that configured the judge gets this for free. */
export function resolveModel(override?: string): string | undefined {
  const candidates = [override, process.env.HEAL_MODEL, process.env.JUDGE_MODEL];
  return candidates.find(value => value !== undefined && value.trim() !== '')?.trim();
}

/** The panel, when one is configured. `HEAL_JURY=local/qwen3:8b,groq/llama-3.3-70b`. */
export function resolveJury(override?: string): string[] {
  const raw = override ?? process.env.HEAL_JURY ?? '';
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
}

/** How many times to ask each model. More samples measure a model's own variance. */
export function resolveSamples(): number {
  const raw = Number(process.env.HEAL_SAMPLES);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(5, Math.floor(raw)) : 1;
}

interface WireRequest {
  url: string;
  init: RequestInit;
  /** Pull the assistant text out of this endpoint's response shape. */
  read: (body: unknown) => string;
}

/** The three request shapes, against the endpoint table rather than a second copy of the URLs. */
function requestFor(
  wire: 'openai' | 'ollama' | 'anthropic',
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  systemPrompt: string,
  userText: string,
): WireRequest {
  const json = { 'Content-Type': 'application/json' };
  if (wire === 'ollama') {
    return {
      url: `${baseUrl}/api/chat`,
      init: {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          model,
          stream: false,
          // Reasoning costs tens of seconds per call on a local model and buys nothing here: the
          // question is a five-way choice, not a proof.
          think: false,
          keep_alive: process.env.JUDGE_OLLAMA_KEEP_ALIVE ?? '30m',
          format: TRIAGE_SCHEMA,
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText },
          ],
        }),
      },
      read: body => (body as { message?: { content?: string } }).message?.content ?? '',
    };
  }
  if (wire === 'anthropic') {
    return {
      url: `${baseUrl}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          ...json,
          'x-api-key': apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
        }),
      },
      read: body =>
        ((body as { content?: Array<{ type: string; text?: string }> }).content ?? [])
          .map(block => (block.type === 'text' ? (block.text ?? '') : ''))
          .join('\n'),
    };
  }
  return {
    url: `${baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: { ...json, Authorization: `Bearer ${apiKey ?? ''}` },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
      }),
    },
    read: body =>
      (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
        ?.content ?? '',
  };
}

export interface AskResult {
  reply: TriageReply;
  /** Set when the call could not be made at all — a missing key, an unreachable endpoint, a 4xx. */
  problem?: string;
}

/**
 * Ask one model once, and re-ask once when the reply was unreadable.
 *
 * Never throws. A failed escalation leaves the deterministic classification exactly as it was, which is
 * the whole safety story of this tier: the worst case is that nothing improves.
 */
export async function askModel(
  kit: JudgeKit,
  modelId: string,
  systemPrompt: string,
  userText: string,
): Promise<AskResult> {
  const kind = kit.kindForModel(modelId);
  const endpoint = kit.endpointForKind(kind);
  if (endpoint === undefined) {
    return {
      reply: { class: 'unknown', reasoning: '' },
      problem: `no endpoint registered for '${kind}' — the provider serves the judge but declared no transport`,
    };
  }

  const send = async (text: string): Promise<TriageReply> => {
    const request = requestFor(
      endpoint.wire,
      endpoint.baseUrl(),
      endpoint.apiKey(),
      kit.stripPrefix(modelId, kind),
      systemPrompt,
      text,
    );
    const response = await kit.judgeFetch(endpoint.label, request.url, request.init);
    if (!response.ok) {
      throw new Error(
        `${endpoint.label} ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }
    return parseTriageReply(request.read(await response.json()), kit.extractJsonObject);
  };

  try {
    const first = await send(userText);
    if (first.unparseable !== true) {
      return { reply: first };
    }
    // One repair attempt, exactly as the judge does. A second failure is not worth a third call.
    const second = await send(`${userText}\n\n${REPAIR_HINT}`);
    return second.unparseable === true
      ? { reply: second, problem: 'the model did not return readable JSON twice' }
      : { reply: second };
  } catch (error) {
    return {
      reply: { class: 'unknown', reasoning: '' },
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}
