import type { APIRequestContext, APIResponse } from '@playwright/test';

import type { ApiResponse, HttpMethod, RequestOptions } from './types';

/**
 * Layer 1 — the base HTTP client. A thin, typed wrapper over Playwright's APIRequestContext that
 * exposes get/post/put/patch/delete, resolves paths against an optional basePath, and normalizes
 * every response into an {@link ApiResponse} (status + parsed body). Service classes (layer 2) build
 * on this; tests (layer 3) never touch the raw request context.
 *
 * @example
 * const client = new ApiClient(request); // `request` is the Playwright fixture
 * const res = await client.get<Pet[]>('/pet/findByStatus', { params: { status: 'available' } });
 * expect(res.ok).toBeTruthy();
 */
export class ApiClient {
  private readonly request: APIRequestContext;
  private readonly basePath: string;
  private readonly defaultHeaders: Record<string, string>;

  /**
   * @param request        Playwright's APIRequestContext (the built-in `request` fixture).
   * @param basePath       Absolute API root prepended to every URL (e.g. 'https://host/api/v3').
   *                       URLs are built by concatenation, so service paths keep their leading slash.
   * @param defaultHeaders Headers sent on every request; a per-request `headers` value overrides
   *                       them. Defaults to `Accept: application/json` — extend for auth tokens, etc.
   */
  constructor(
    request: APIRequestContext,
    basePath = '',
    defaultHeaders: Record<string, string> = { Accept: 'application/json' },
  ) {
    this.request = request;
    this.basePath = basePath;
    this.defaultHeaders = defaultHeaders;
  }

  async get<T>(url: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('GET', url, options);
  }

  async post<T>(url: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('POST', url, options);
  }

  async put<T>(url: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('PUT', url, options);
  }

  async patch<T>(url: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('PATCH', url, options);
  }

  async delete<T>(url: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.send<T>('DELETE', url, options);
  }

  /** Single code path for every verb: issue the request and normalize the response. */
  private async send<T>(
    method: HttpMethod,
    url: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const response = await this.request.fetch(`${this.basePath}${url}`, {
      method,
      params: options.params,
      headers: { ...this.defaultHeaders, ...options.headers },
      data: options.data,
    });

    return {
      status: response.status(),
      ok: response.ok(),
      headers: response.headers(),
      data: await this.parseBody<T>(response),
    };
  }

  /**
   * Parse the body without throwing: JSON when the response advertises JSON, otherwise raw text;
   * `undefined` for an empty body (e.g. a 204 or a bare-text DELETE). Reading via text() first
   * avoids APIResponse.json() throwing on non-JSON payloads (Petstore's DELETE returns "Pet deleted").
   */
  private async parseBody<T>(response: APIResponse): Promise<T> {
    const body = await response.text();
    if (body.length === 0) {
      return undefined as T;
    }
    const contentType = response.headers()['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(body) as T;
      } catch {
        return body as unknown as T;
      }
    }
    return body as unknown as T;
  }
}
