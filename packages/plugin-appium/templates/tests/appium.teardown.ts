import { test } from '@playwright/test';

import { stopBootedDevices } from '@pwtap/plugin-appium';

/**
 * Appium teardown — runs automatically AFTER the `appium` project (wired via
 * `teardown: 'appium-teardown'` in playwright.config.ts). Shuts down the emulators/simulators the
 * framework auto-booted this run — headed or headless — so they don't linger. Devices you booted
 * yourself are left running; set `APPIUM_KEEP_DEVICES=1` to keep auto-booted ones too. Keep the file
 * name `appium.teardown.ts` — the appium-teardown project matches tests by it.
 */
test('shut down framework-booted devices', async () => {
  await stopBootedDevices();
});
