import type { APIRequestContext } from '@playwright/test';

/** HTTP verbs supported by the base client. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The options accepted by Playwright's APIRequestContext.fetch — reused so our types never drift. */
type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

/** Per-request options passed to the base client methods. */
export interface RequestOptions {
  /** Query-string parameters appended to the URL. */
  params?: FetchOptions['params'];
  /** Extra headers merged over the client/project defaults. */
  headers?: FetchOptions['headers'];
  /** Request body. A plain object is serialized as JSON (Content-Type set automatically). */
  data?: FetchOptions['data'];
}

/** A parsed HTTP response: status + typed body, decoupled from Playwright's APIResponse. */
export interface ApiResponse<T> {
  /** HTTP status code (e.g. 200, 404). */
  status: number;
  /** True for 2xx responses. */
  ok: boolean;
  /** Parsed body: JSON when the response is JSON, else the raw text; undefined when the body is empty. */
  data: T;
  /** Response headers (lower-cased keys). */
  headers: Record<string, string>;
}
