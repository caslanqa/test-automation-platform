import { test } from '@playwright/test';

import { stopBootedDevices } from '@pwtap/plugin-maestro';

/**
 * Maestro teardown — runs automatically AFTER the `maestro` project (wired via
 * `teardown: 'maestro-teardown'` in playwright.config.ts). Shuts down the emulators/simulators the
 * framework auto-booted this run — headed or headless — so they don't linger. Devices you booted
 * yourself are left running; set `MOBILE_KEEP_DEVICES=1` to keep auto-booted ones too. Keep the file
 * name `maestro.teardown.ts` — the maestro-teardown project matches tests by it.
 */
test('shut down framework-booted devices', async () => {
  await stopBootedDevices();
});
