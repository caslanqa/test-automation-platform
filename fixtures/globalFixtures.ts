import { test as base, expect } from '@playwright/test';

import { loadEnv } from '@config/loadEnv';

import { authState, defaultCreateLoginPage, ensureSession, type CreateLoginPage } from './auth';

// Load the selected environment (TEST_ENV, JUDGE_*, BASE_URL → baseURL) before any test runs.
loadEnv();

/** Options this test object adds on top of the built-in Playwright fixtures. */
export interface AuthOptions {
  /**
   * Session key to authenticate the test/describe as. On first use its `.auth/<session>.json` is
   * created by logging in (once, worker-safe) and then reused on later runs; the state is applied
   * as the context's `storageState`. Leave unset for an unauthenticated context.
   */
  session: string | undefined;
}

/** Non-option fixtures this test object adds. */
interface AuthFixtures {
  /**
   * Factory mapping a session key to its login page object. Init'd here so the auth flow logs in
   * through a page object (never constructing one inline). Override to wire your app's page objects.
   */
  createLoginPage: CreateLoginPage;
}

/**
 * Project test object. Adds one option — `session` — for lazy, cached, storageState-key login:
 *
 * @example
 * test.use({ session: 'admin' });               // whole file → .auth/admin.json
 * test.describe(() => {
 *   test.use({ session: 'customer' });           // just this group → .auth/customer.json
 *   test('...', async ({ page }) => {  ...  });
 * });
 *
 * The first test that uses a session logs in and caches `.auth/<session>.json`; subsequent tests
 * and runs reuse it (no repeated logins). Without `session`, the context is unauthenticated — or
 * pass a native `storageState` path/object as usual; both work unchanged.
 */
export const test = base.extend<AuthOptions & AuthFixtures>({
  session: [undefined, { option: true }],

  // The login page-object factory, provided as a fixture so the auth flow doesn't `new` one inline.
  createLoginPage: async ({}, use) => {
    await use(defaultCreateLoginPage);
  },

  // When a session key is set: ensure its cached state exists (log in on a miss via the factory),
  // then use it. Otherwise pass through whatever storageState the test/project already specified.
  storageState: async ({ browser, session, storageState, createLoginPage }, use) => {
    if (session === undefined) {
      await use(storageState);
      return;
    }
    await ensureSession(browser, session, createLoginPage);
    await use(authState(session));
  },
});

export { expect };
