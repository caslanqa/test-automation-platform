import { test } from '@fixtures/mobileFixtures';

// Mobile tests read like the UI and API tests: pick the device with `test.use({ mobile })`, then run
// a Maestro YAML flow with `maestro.run(...)`. Add `device` (Android AVD name, or iOS simulator name
// or UDID) to auto-boot it; omit it to use an already-booted device (or set MOBILE_DEVICE). If no
// matching device is available, the test is skipped (not failed).

test.describe('Settings app — Android', () => {
  test.use({ mobile: { platform: 'android' } }); // add device: '<your AVD name>' (e.g. 'Pixel_7_API_34') to auto-boot it

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/android/settings.yaml');
  });
});

test.describe('Settings app — iOS', () => {
  test.use({ mobile: { platform: 'ios' } }); // add device: '<your simulator name or UDID>' (e.g. 'iPhone 16 Pro') to auto-boot it

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/ios/settings.yaml');
  });
});
