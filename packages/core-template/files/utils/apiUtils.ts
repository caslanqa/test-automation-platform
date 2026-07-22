import { APIRequestContext, APIResponse, request } from '@playwright/test';

/**
 * API Utility Functions for Playwright Tests
 * Provides common API interaction helpers
 */

export interface RequestOptions {
  headers?: Record<string, string>;
  data?: unknown;
  params?: Record<string, string | number | boolean>;
  timeout?: number;
}

export interface APIConfig {
  baseURL: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export class APIUtils {
  private apiContext: APIRequestContext | null = null;
  private config: APIConfig;

  constructor(config: APIConfig) {
    this.config = config;
  }

  /**
   * Initialize API context
   * Note: baseURL is NOT set in context to avoid automatic "/" insertion
   * URLs will be manually concatenated in request methods
   */
  async init(): Promise<void> {
    this.apiContext = await request.newContext({
      extraHTTPHeaders: this.config.headers || {},
      timeout: this.config.timeout || 30000,
    });
  }

  /**
   * Dispose API context
   */
  async dispose(): Promise<void> {
    if (this.apiContext) {
      await this.apiContext.dispose();
    }
  }

  /**
   * Set authorization token
   */
  setAuthToken(token: string, type: 'Bearer' | 'Basic' = 'Bearer'): void {
    if (!this.config.headers) {
      this.config.headers = {};
    }
    this.config.headers['Authorization'] = `${type} ${token}`;
  }

  /**
   * Get API context
   */
  getContext(): APIRequestContext {
    if (!this.apiContext) {
      throw new Error('API context not initialized. Call init() first.');
    }
    return this.apiContext;
  }

  /**
   * Build full URL by concatenating baseURL and path
   * @param path - Relative path or full URL
   * @returns Full URL
   */
  private buildUrl(path: string): string {
    // If path is already a full URL, return it as is
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    // Direct concatenation without adding "/"
    return `${this.config.baseURL}${path}`;
  }

  /**
   * Make GET request
   */
  async get(url: string, options?: RequestOptions): Promise<APIResponse> {
    const context = this.getContext();
    const fullUrl = this.buildUrl(url);
    return await context.get(fullUrl, {
      headers: options?.headers,
      params: options?.params as Record<string, string | number | boolean>,
      timeout: options?.timeout,
    });
  }

  /**
   * Make POST request
   */
  async post(url: string, options?: RequestOptions): Promise<APIResponse> {
    const context = this.getContext();
    const fullUrl = this.buildUrl(url);
    return await context.post(fullUrl, {
      headers: options?.headers,
      data: options?.data,
      params: options?.params as Record<string, string | number | boolean>,
      timeout: options?.timeout,
    });
  }

  /**
   * Make PUT request
   */
  async put(url: string, options?: RequestOptions): Promise<APIResponse> {
    const context = this.getContext();
    const fullUrl = this.buildUrl(url);
    return await context.put(fullUrl, {
      headers: options?.headers,
      data: options?.data,
      params: options?.params as Record<string, string | number | boolean>,
      timeout: options?.timeout,
    });
  }

  /**
   * Make PATCH request
   */
  async patch(url: string, options?: RequestOptions): Promise<APIResponse> {
    const context = this.getContext();
    const fullUrl = this.buildUrl(url);
    return await context.patch(fullUrl, {
      headers: options?.headers,
      data: options?.data,
      params: options?.params as Record<string, string | number | boolean>,
      timeout: options?.timeout,
    });
  }

  /**
   * Make DELETE request
   */
  async delete(url: string, options?: RequestOptions): Promise<APIResponse> {
    const context = this.getContext();
    const fullUrl = this.buildUrl(url);
    return await context.delete(fullUrl, {
      headers: options?.headers,
      data: options?.data,
      params: options?.params as Record<string, string | number | boolean>,
      timeout: options?.timeout,
    });
  }

  /**
   * Make HEAD request
   */
  async head(url: string, options?: RequestOptions): Promise<APIResponse> {
    const context = this.getContext();
    const fullUrl = this.buildUrl(url);
    return await context.head(fullUrl, {
      headers: options?.headers,
      params: options?.params as Record<string, string | number | boolean>,
      timeout: options?.timeout,
    });
  }

  /**
   * Parse JSON response
   */
  static async parseJSON<T = unknown>(response: APIResponse): Promise<T> {
    return await response.json();
  }

  /**
   * Get response text
   */
  static async getText(response: APIResponse): Promise<string> {
    return await response.text();
  }

  /**
   * Get response body as buffer
   */
  static async getBody(response: APIResponse): Promise<Buffer> {
    return await response.body();
  }

  /**
   * Get response headers
   */
  static getHeaders(response: APIResponse): Record<string, string> {
    return response.headers();
  }

  /**
   * Get response status code
   */
  static getStatus(response: APIResponse): number {
    return response.status();
  }

  /**
   * Check if response is successful (2xx)
   */
  static isSuccess(response: APIResponse): boolean {
    const status = response.status();
    return status >= 200 && status < 300;
  }

  /**
   * Check if response is client error (4xx)
   */
  static isClientError(response: APIResponse): boolean {
    const status = response.status();
    return status >= 400 && status < 500;
  }

  /**
   * Check if response is server error (5xx)
   */
  static isServerError(response: APIResponse): boolean {
    const status = response.status();
    return status >= 500;
  }
}
