import { test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';

test.describe('Settings app — Android', () => {
  test.use({ mobile: { ...devices.pixel9, headless: false } });

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/android/settings.yaml');
  });
});

test.describe('Settings app — iOS', () => {
  test.use({ mobile: { ...devices.iphone16, headless: false } });

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/ios/settings.yaml');
  });
});

test.describe('Settings app — Android 2', () => {
  test.use({ mobile: { ...devices.pixel9b, headless: false } });

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/android/settings.yaml');
  });
});