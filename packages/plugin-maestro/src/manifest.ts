/**
 * @pwtap/create injection manifest for the Maestro plugin. Adds a `maestroTest` fixture (merged into
 * the `@fixtures` barrel via mergeTests), an env-gated `maestro` Playwright project (so a bare
 * `npm test` stays UI + API), the `MOBILE_*` env keys the engine reads, example specs + flows, and a
 * host check. The `maestro` project sets no `testDir` — it inherits the project's top-level tests
 * folder (so it respects a renamed tests dir) and matches `*.mobile.ts`.
 *
 * @example
 * // after `npx create-pwtap add maestro`, gated behind MAESTRO=1:
 * //   npm run test:maestro   →  MAESTRO=1 playwright test --project=maestro
 */
export const manifest = {
  id: 'maestro',
  name: '@pwtap/plugin-maestro',
  devDependencies: {},
  scripts: {
    'test:maestro': 'MAESTRO=1 playwright test --project=maestro',
    'mobile:create-device': 'node node_modules/@pwtap/plugin-maestro/bin/create-device.mjs',
    'mobile:stop-devices': 'node node_modules/@pwtap/plugin-maestro/bin/stop-devices.mjs',
  },
  envKeys: {
    MOBILE_PLATFORM: 'android',
    MOBILE_DEVICE: '',
    MOBILE_HEADLESS: 'true',
    MOBILE_APP_ANDROID: '',
    MOBILE_APP_IOS: '',
    MOBILE_STEP_LOGS: '',
    MOBILE_DEVICE_LOG: '',
    MOBILE_KEEP_DEVICES: '',
    MAESTRO_BIN: '',
  },
  fixture: {
    importFrom: '@pwtap/plugin-maestro',
    test: { alias: 'maestroTest' },
  },
  playwrightProject: {
    gateVar: 'maestroEnabled',
    gate: "const maestroEnabled = process.env.MAESTRO === '1';",
    // fullyParallel + a per-device lock (in the fixture) = the device pool: tests on the SAME device
    // serialize, DIFFERENT devices/platforms run concurrently (with --workers). `teardown` runs the
    // maestro-teardown project after the run, shutting down framework-booted devices automatically.
    project:
      "...(maestroEnabled ? [{ name: 'maestro', testMatch: /.*\\.mobile\\.ts$/, fullyParallel: true, teardown: 'maestro-teardown' }, { name: 'maestro-teardown', testMatch: /maestro\\.teardown\\.ts$/ }] : [])",
  },
  examples: [
    { src: 'templates/tests', dest: 'tests/maestro' },
    { src: 'templates/flows', dest: 'tests/maestro/flows' },
  ],
  docs: [{ src: 'docs/MOBILE_TESTING.md', dest: 'docs/MOBILE_TESTING.md' }],
  ensure: 'ensure',
  readmeSection: [
    '## Mobile (Maestro)',
    '',
    'Two authoring styles in one `maestro` fixture, mixable per test — an imperative Playwright-style',
    'API and batch YAML flows:',
    '',
    '```ts',
    "import { test, expect } from '@fixtures';",
    "import { devices } from '@pwtap/plugin-maestro';",
    '',
    'test.use({ mobile: devices.android });',
    '',
    "test('imperative', async ({ maestro }) => {",
    "  await maestro.launchApp('com.android.settings');",
    "  await maestro.tapOn('Network & internet');",
    "  await maestro.assertVisible('Internet');",
    '});',
    '',
    "test('yaml flow', async ({ maestro }) => {",
    "  await maestro.run('tests/maestro/flows/android/settings.yaml');",
    '});',
    '```',
    '',
    'Runs gated: `npm run test:maestro` (or `MAESTRO=1 playwright test --project=maestro`). A named',
    'device auto-boots; with none available the test skips. Needs the Maestro CLI + a JDK 17+, and an',
    'Android SDK / Xcode for the respective platform. `npm run mobile:create-device` builds a device;',
    '`npm run mobile:stop-devices` shuts down the ones the framework auto-booted.',
  ].join('\n'),
};
