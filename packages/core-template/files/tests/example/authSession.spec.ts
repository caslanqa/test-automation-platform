import { expect, test } from '@fixtures';

/**
 * RUNNABLE DEMO of lazy, cached session auth.
 *
 * `test.use({ session: 'demoUser' })` triggers a one-time login to saucedemo.com (see
 * fixtures/auth.ts → ensureSession) which caches `.auth/demoUser.json`; every later test and run
 * reuses that file — no repeated logins, no setup project.
 *
 * Run: `npx playwright test tests/example/authSession.spec.ts --project=chromium`
 *
 * NOTE: each session needs its own describe with a single `test.use({ session })` — two `test.use`
 * calls in one describe do not create two scopes; the last one wins for every test in that describe.
 */
const INVENTORY_URL = 'https://www.saucedemo.com/inventory.html';

test.describe('with the "demoUser" session', () => {
  test.use({ session: 'demoUser' });

  test('reaches the inventory without logging in again', async ({ page }) => {
    await page.goto(INVENTORY_URL);

    await expect(page).toHaveURL(/\/inventory\.html/);
    await expect(page.locator('.title')).toHaveText('Products');
  });
});

test.describe('without a session', () => {
  test('is bounced to the login page', async ({ page }) => {
    await page.goto(INVENTORY_URL);

    await expect(page).toHaveURL('https://www.saucedemo.com/');
  });
});
