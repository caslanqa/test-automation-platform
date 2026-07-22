import path from 'node:path';

import { expect, test } from '@fixtures';
import { devices } from '@pwtap/plugin-maestro';

/**
 * Maestro example — the two authoring styles, mixable per test. These target the built-in Settings
 * app (present on every emulator/simulator, so they need no app install). They SKIP gracefully when
 * no matching device is booted, so they're safe to keep. Run them with `npm run test:maestro`.
 */

test.describe('Settings — Android (batch YAML flow)', () => {
  test.use({ mobile: devices.android });

  test('launches the Settings app', async ({ maestro }) => {
    // The flow file sits next to this spec, so the path survives a renamed tests folder.
    await maestro.run(path.join(import.meta.dirname, 'flows/android/settings.yaml'));
  });
});

test.describe('Settings — iOS (imperative, Playwright-style)', () => {
  test.use({ mobile: devices.ios });

  test('navigates the Settings app', async ({ maestro }) => {
    await maestro.launchApp('com.apple.Preferences');
    await maestro.takeScreenshot('settings-home');

    await maestro.scrollUntilVisible('General');
    await maestro.tapOn('General');
    await maestro.assertVisible('About');

    await maestro.tapOn('About');
    // `rowValue` reads the value in the labelled row (cross-platform); assert it's present.
    expect(await maestro.rowValue('Name'), 'About → Name').toBeTruthy();
  });
});
