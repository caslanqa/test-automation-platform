import { test as base, expect } from '@playwright/test';

import { ApiClient } from '@api/core/ApiClient';
import { PetService } from '@api/services/PetService';
import { loadEnv } from '@config/loadEnv';

// Load the selected environment (API_BASE_URL → the api project's baseURL) before any test runs.
loadEnv();

/** API-layer fixtures: the base client (layer 1) and the services (layer 2) built on top of it. */
export interface ApiFixtures {
  /** Layer 1 — base HTTP client bound to this test's APIRequestContext (baseURL = API_BASE_URL). */
  apiClient: ApiClient;
  /** Layer 2 — Petstore /pet business service. */
  petService: PetService;
}

/**
 * Test object for API tests. It extends the plain Playwright base (no browser/auth — API tests need
 * neither) with an `apiClient` wrapping the built-in `request` fixture, so the client inherits the
 * api project's baseURL/headers, plus the service objects. Import this in tests/api/*.api.ts.
 *
 * @example
 * import { test, expect } from '@fixtures/apiFixtures';
 * test('available pets', async ({ petService }) => {
 *   const pets = await petService.findAvailable();
 *   expect(pets.length).toBeGreaterThan(0);
 * });
 */
export const test = base.extend<ApiFixtures>({
  apiClient: async ({ request }, use) => {
    // API_BASE_URL (env/environments.json) includes a path (/api/v3), so we pass it as the client's
    // basePath and build URLs by absolute concatenation — a leading-slash path against a context
    // baseURL would drop that path (WHATWG URL join) and hit the wrong host root.
    const baseUrl = process.env.API_BASE_URL;
    if (baseUrl === undefined || baseUrl.length === 0) {
      throw new Error('[api] API_BASE_URL is not set (env/environments.json)');
    }
    await use(new ApiClient(request, baseUrl));
  },
  petService: async ({ apiClient }, use) => {
    await use(new PetService(apiClient));
  },
});

export { expect };
