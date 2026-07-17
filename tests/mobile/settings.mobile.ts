import { test, expect } from '@fixtures/mobileFixtures';
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

test.describe('Settings app — iOS (imperative API)', () => {
  test.use({ mobile: { ...devices.iphone16, headless: false } });

  test('navigates Settings imperatively', async ({ maestro }) => {
    await maestro.launchApp('com.apple.Preferences');
    await maestro.takeScreenshot('settings-home');

    await maestro.scrollUntilVisible('General');
    await maestro.tapOn('General');
    await maestro.assertVisible('About');

    await maestro.tapOn('About');
    expect(await maestro.rowValue('Capacity')).toBe('494,38 GB');
  });
});

test.describe('Row text value(imperative API)', () => {
  test.use({ mobile: { ...devices.iphone16, headless: false } });

  test('navigates Settings imperatively', async ({ maestro }) => {
    await maestro.launchApp('com.apple.Preferences');

    await maestro.scrollUntilVisible('Accessibility');
    await maestro.tapOn('Accessibility');
    await maestro.assertVisible('Accessibility');

    await maestro.tapOn('Display & Text Size');
    expect(await maestro.rowValue('Larger Text')).toBe('Off');
  });
});

test.describe('Settings app — Android 2', () => {
  test.use({ mobile: { ...devices.pixel9b, headless: false } });

  test('launches the Settings app', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/android/settings.yaml');
  });
});
