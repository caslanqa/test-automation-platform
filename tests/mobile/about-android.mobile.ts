import { expect, test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';

test.describe('Settings app — Android (About: relational checks)', () => {
  test.use({ mobile: { ...devices.pixel9, headless: false } });

  // The Android counterpart of about.mobile.ts. Android stacks a row's value BELOW its label (iOS
  // puts it to the right / on the same node) — the framework handles both, so the test reads the same.
  test('the About "Device name" row resolves to the model', async ({ maestro }) => {
    await maestro.launchApp('com.android.settings');

    // Emulators label it "About emulated device"; real phones say "About phone".
    const about = (await maestro.isVisible('About phone', { timeout: 1500 }))
      ? 'About phone'
      : 'About emulated device';
    await maestro.scrollUntilVisible(about);
    await maestro.tapOn(about);
    await maestro.assertVisible('Device name');

    // (1) Relational selector — on Android the value sits BELOW its label, so anchor with `below:`.
    await maestro.assertVisible({ text: 'sdk_gphone.*', below: { text: 'Device name' } });

    // (2) rowValue is cross-platform: here it reads the value stacked under the label (no code change
    //     from the iOS test — the framework tries same-node, right-of, then below).
    expect(await maestro.rowValue('Device name'), 'About → Device name').toContain('sdk_gphone');
  });
});
