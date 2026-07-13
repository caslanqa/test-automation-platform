import { test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';

// Mobile tests read like the UI and API tests: pick the device with `test.use({ mobile })`, then run
// a Maestro YAML flow with `maestro.run(...)`. Devices come from the catalog in mobile/devices.ts —
// add a `device` there to auto-boot a specific AVD/simulator; otherwise an already-booted device is
// used (or the test is skipped, not failed).

test.describe('Settings app — Android', () => {
  test.use({ mobile: devices.pixel7 });

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/android/settings.yaml');
  });
});

test.describe('Settings app — iOS', () => {
  test.use({ mobile: devices.iphone16 });

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/ios/settings.yaml');
  });
});
