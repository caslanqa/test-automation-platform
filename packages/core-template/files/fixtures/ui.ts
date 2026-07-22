import { test as base, expect, type TestInfo, type TestType } from '@playwright/test';

import { loadEnv } from '@config/loadEnv';

import { authState, defaultCreateLoginPage, ensureSession, type CreateLoginPage } from './auth';

// Load the selected environment (TEST_ENV → BASE_URL → baseURL) before any test runs.
loadEnv();

/** Annotation type carrying a per-test session key, set by `test.as(session)` and read by storageState. */
const SESSION_ANNOTATION = 'pwtap:session';

/** Options this test object adds on top of the built-in Playwright fixtures. */
export interface AuthOptions {
  /**
   * Suite-level session key: `test.use({ session })` at file/describe scope authenticates every test
   * in that scope. On first use its `.auth/<session>.json` is created by logging in (once,
   * worker-safe) and reused later. Leave unset for an unauthenticated context. For per-test auth use
   * `test.as(session)` instead.
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
 * Core UI test object. Adds a `session` option for suite-level auth and overrides `storageState` so
 * the authenticated state is applied lazily and cached. Per-test auth is layered on separately by
 * `withSessionAuth` (the `test.as(session)` API), which sets an annotation this fixture reads.
 */
export const test = base.extend<AuthOptions & AuthFixtures>({
  session: [undefined, { option: true }],

  // The login page-object factory, provided as a fixture so the auth flow doesn't `new` one inline.
  createLoginPage: async ({}, use) => {
    await use(defaultCreateLoginPage);
  },

  // Effective session = per-test annotation (test.as) > suite-level option (test.use) > none.
  // When set, ensure the cached state exists (log in on a miss) and apply it as storageState.
  storageState: async ({ browser, session, storageState, createLoginPage }, use, testInfo) => {
    const perTest = testInfo.annotations.find(a => a.type === SESSION_ANNOTATION)?.description;
    const effective = perTest ?? session;
    if (effective === undefined) {
      await use(storageState);
      return;
    }
    await ensureSession(browser, effective, createLoginPage);
    await use(authState(effective));
  },
});

export { expect };

/** A test object of any fixture shape — the constraint for the session-auth helpers below. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTest = TestType<any, any>;

/** Fixtures + worker args of a test type, as passed to its test body. */
type TestArgsOf<T> = T extends TestType<infer A, infer W> ? A & W : never;
type SessionTestBody<T> = (args: TestArgsOf<T>, testInfo: TestInfo) => void | Promise<void>;

/** A session-bound test declarator: callable like `test`, with the standard declaration modifiers. */
export interface SessionBoundTest<T extends AnyTest> {
  (title: string, body: SessionTestBody<T>): void;
  skip(title: string, body: SessionTestBody<T>): void;
  only(title: string, body: SessionTestBody<T>): void;
  fixme(title: string, body: SessionTestBody<T>): void;
  fail(title: string, body: SessionTestBody<T>): void;
}

/**
 * Attach `.as(session)` to a test object for test-level auth. `test.as('admin')('title', fn)` runs
 * that single test authenticated as `admin` (its `page`/`storageState` carry the cached session), and
 * `.skip`/`.only`/`.fixme`/`.fail` work the same. It sets a declaration-time annotation the
 * `storageState` fixture reads, so it composes with suite-level `test.use({ session })`.
 *
 * @example
 * export const test = withSessionAuth(mergeTests(uiTest, apiTest));
 * test.as('adminUser')('sees dashboard', async ({ page }) => { await page.goto('/dashboard'); });
 * test.as('customerUser').fixme('broken flow', async ({ page }) => { await page.goto('/x'); });
 */
export function withSessionAuth<T extends AnyTest>(
  testObj: T,
): T & { as: (session: string) => SessionBoundTest<T> } {
  const as = (session: string): SessionBoundTest<T> => {
    const details = { annotation: { type: SESSION_ANNOTATION, description: session } };
    // Playwright's declaration forms accept (title, details, body); cast to reach them generically.
    const decl = testObj as unknown as {
      (title: string, details: unknown, body: unknown): void;
      skip(title: string, details: unknown, body: unknown): void;
      only(title: string, details: unknown, body: unknown): void;
      fixme(title: string, details: unknown, body: unknown): void;
      fail(title: string, details: unknown, body: unknown): void;
    };
    const bound = ((title: string, body: SessionTestBody<T>) =>
      decl(title, details, body)) as SessionBoundTest<T>;
    bound.skip = (title, body) => decl.skip(title, details, body);
    bound.only = (title, body) => decl.only(title, details, body);
    bound.fixme = (title, body) => decl.fixme(title, details, body);
    bound.fail = (title, body) => decl.fail(title, details, body);
    return bound;
  };
  return Object.assign(testObj, { as });
}
