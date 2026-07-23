import { expect, test } from '@fixtures';
import { devices } from '@pwtap/plugin-appium';

/**
 * Appium example — a raw WebdriverIO session against the built-in Settings/Preferences app (no app
 * install needed). `app` is callable as a selector shorthand (`app('~Login')` is `app.$('~Login')`)
 * and still the full WebdriverIO driver otherwise, so element lookups don't auto-wait like Playwright
 * locators — `expect.poll(...)` gives the same retry-until-true behavior. SKIPS gracefully when no
 * matching device is booted, so it's safe to keep. Run with `npm run test:appium`.
 */

test.describe('Settings — Android', () => {
  test.use({
    appium: {
      ...devices.android,
      capabilities: {
        'appium:appPackage': 'com.android.settings',
        'appium:appActivity': '.Settings',
      },
    },
  });

  test('opens Network & internet', async ({ app }) => {
    await app('~Network & internet').click();
    const internet = app('~Internet');
    await expect.poll(() => internet.isDisplayed()).toBe(true);
  });
});

test.describe('Settings — iOS (Preferences)', () => {
  test.use({
    appium: { ...devices.ios, capabilities: { 'appium:bundleId': 'com.apple.Preferences' } },
  });

  test('opens General', async ({ app }) => {
    await app('~General').click();
    const about = app('~About');
    await expect.poll(() => about.isDisplayed()).toBe(true);
  });
});
