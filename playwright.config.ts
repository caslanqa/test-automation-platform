import { defineConfig, devices } from '@playwright/test';

import { loadEnv } from './config/loadEnv';

// Load environment variables from env/environments.json
loadEnv();

/**
 * Playwright Test Configuration
 *
 * Key features:
 * - Multi-project setup for different browsers
 * - Lazy session auth: storage states created on first use and cached (fixtures/auth.ts)
 * - Environment-driven baseURL from loadEnv
 * - Parallel execution with worker isolation
 * - Multiple reporters (HTML, Allure, JSON)
 *
 * Run examples:
 *   npx playwright test                    # Run all tests
 *   npx playwright test --project=chromium # Run Chrome only
 *   npx playwright test --grep @smoke      # Run smoke tests
 *   TEST_ENV=staging npx playwright test   # Run against staging
 */
export default defineConfig({
    testDir: './tests',

    // Test file patterns
    testMatch: ['**/*.spec.ts', '**/*.test.ts'],

    // Ignore patterns
    testIgnore: ['**/setup/**', '**/helpers/**', '**/*.helper.ts'],

    // Parallel execution
    fullyParallel: true,
    workers: process.env.CI ? 2 : undefined,

    // Fail fast in CI, allow retries otherwise
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,

    // Global timeout per test
    timeout: 60 * 1000,

    // Expect timeout
    expect: {
        timeout: 10 * 1000,
    },

    // Reporter configuration
    reporter: [
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
        [
            'allure-playwright',
            {
                detail: true,
                outputFolder: 'allure-results',
                suiteTitle: false,
            },
        ],
        ['list'],
    ],

    // Output directory for test artifacts
    outputDir: 'test-results/',

    // Global setup/teardown (optional)
    // globalSetup: require.resolve('./tests/global-setup.ts'),
    // globalTeardown: require.resolve('./tests/global-teardown.ts'),

    // Shared settings for all projects
    use: {
        // Base URL — single source of truth: env/environments.json → loadEnv → process.env.BASE_URL.
        baseURL: process.env.BASE_URL,

        // Browser options
        headless: false,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,

        // Artifacts on failure
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        trace: 'retain-on-failure',

        // Navigation timeout
        navigationTimeout: 30 * 1000,

        // Action timeout
        actionTimeout: 15 * 1000,

        // Locale and timezone
        locale: 'en-US',
        timezoneId: 'UTC',
    },

    // Project definitions
    projects: [
        // ============================================
        // BROWSER PROJECTS
        // ============================================
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // Auth is per-test and lazy: opt in with `test.use({ session: 'admin' })`. The first
                // test using a session logs in once and caches .auth/<session>.json; later tests and
                // runs reuse it — no setup project or global storageState needed.
            },
        },

        // ============================================
        // API TESTS - No browser; layered client/service (see api/ + fixtures/apiFixtures.ts)
        // ============================================
        {
            // Pure API project — no `use` block: the base URL and default headers live in the layered
            // client (api/core/ApiClient.ts, wired via fixtures/apiFixtures.ts from API_BASE_URL), so
            // there is nothing browser- or HTTP-specific to configure here.
            name: 'api',
            testDir: './tests/api',
            testMatch: /.*\.api\.ts$/,
        },

        /*{
            name: 'firefox',
            use: {
                ...devices['Desktop Firefox'],
            },
            dependencies: ['setup'],
        },

        {
            name: 'webkit',
            use: {
                ...devices['Desktop Safari'],
            },
            dependencies: ['setup'],
        },

        // ============================================
        // MOBILE PROJECTS
        // ============================================
        {
            name: 'mobile-chrome',
            use: {
                ...devices['Pixel 5'],
            },
            dependencies: ['setup'],
        },

        {
            name: 'mobile-safari',
            use: {
                ...devices['iPhone 12'],
            },
            dependencies: ['setup'],
        },*/
    ],

    // Web server configuration (optional - start your app before tests)
    // webServer: {
    //   command: 'npm run start',
    //   url: 'http://localhost:3000',
    //   reuseExistingServer: !process.env.CI,
    //   timeout: 120 * 1000,
    // },
});
