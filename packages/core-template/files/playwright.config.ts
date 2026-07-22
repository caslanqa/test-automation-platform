import { defineConfig, devices } from '@playwright/test';

import { loadEnv } from '@config/loadEnv';

// Load env/environments.json (TEST_ENV → BASE_URL/API_BASE_URL → process.env) before defining config.
loadEnv();

// Plugin gates (e.g. `const maestroEnabled = process.env.MAESTRO === '1';`) are spliced in below by
// `create-pwtap add|remove`. Keep these markers — the tool rewrites only between them.
// pwtap:plugins:gates
// pwtap:plugins:gates:end

/**
 * Playwright configuration. Core ships two projects — `chromium` (UI) and `api`. Each opt-in plugin
 * registers its own env-gated project between the markers, so a bare `npm test` stays UI + API only.
 *
 * @example
 *   npx playwright test                      # chromium + api
 *   npx playwright test --project=chromium   # UI only
 *   TEST_ENV=staging npx playwright test     # against the staging env block
 */
export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  testIgnore: ['**/setup/**', '**/helpers/**', '**/*.helper.ts'],

  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },

  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['allure-playwright', { detail: true, outputFolder: 'allure-results', suiteTitle: false }],
    ['list'],
  ],
  outputDir: 'test-results/',

  use: {
    baseURL: process.env.BASE_URL,
    headless: false,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    navigationTimeout: 30 * 1000,
    actionTimeout: 15 * 1000,
    locale: 'en-US',
    timezoneId: 'UTC',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Pure API project — baseURL/headers live in the layered client (api/core/ApiClient.ts,
      // wired via fixtures/api.ts from API_BASE_URL), so there is nothing to configure here.
      name: 'api',
      testDir: './tests/api',
      testMatch: /.*\.api\.ts$/,
    },
    // pwtap:plugins:projects
    // pwtap:plugins:projects:end
  ],
});
