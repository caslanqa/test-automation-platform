import fs from 'fs';
import path from 'path';

import { test as base, expect } from '@playwright/test';

import { loadEnv } from '@config/loadEnv';
import { DeviceManager } from '@mobile/core/DeviceManager';
import { MaestroRunner } from '@mobile/core/MaestroRunner';
import type { DiscoveredDevice, MobilePlatform } from '@mobile/core/types';

// Load the selected environment (MOBILE_PLATFORM → process.env) before any test runs.
loadEnv();

/** Options this test object adds. */
export interface MobileOptions {
  /**
   * Mobile run selection. Set per file/describe with
   * `test.use({ mobile: { platform: 'android', device: 'Pixel_7_API_34' } })`.
   * - `platform` falls back to the `MOBILE_PLATFORM` env var.
   * - `device` (Android AVD name, or iOS simulator name/UDID) falls back to `MOBILE_DEVICE`; when
   *   set, the device is booted automatically if it isn't running. When omitted, an already-booted
   *   device is used (otherwise the test skips).
   */
  mobile: { platform?: MobilePlatform; device?: string } | undefined;
}

/** The runtime facade a mobile test uses. */
export interface MaestroFixture {
  /** The booted device this test is running against. */
  device: DiscoveredDevice;
  /** Run a Maestro flow (project-relative path) and attach its artifacts to the report. */
  run(flowPath: string, options?: { tags?: string[] }): Promise<void>;
}

interface MobileFixtures {
  maestro: MaestroFixture;
}

/** Resolve the active platform from the `mobile` option or `MOBILE_PLATFORM` env; throw if neither. */
function resolvePlatform(option: MobileOptions['mobile']): MobilePlatform {
  const platform = option?.platform ?? process.env.MOBILE_PLATFORM;
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(
      "[mobile] platform not set — use test.use({ mobile: { platform: 'android' | 'ios' } }) " +
        'or set MOBILE_PLATFORM in env/environments.json'
    );
  }
  return platform;
}

/** Recursively collect the PNG screenshots Maestro wrote under `dir`. */
function screenshots(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { recursive: true })
    .map(entry => path.join(dir, String(entry)))
    .filter(file => file.toLowerCase().endsWith('.png'));
}

/**
 * Mobile test object. Adds a `mobile` selection option and a `maestro` fixture that runs Maestro
 * flows against a booted device and bridges Maestro artifacts into the Playwright report. Extends
 * the plain Playwright base (mobile needs no browser). When no device is booted for the platform,
 * the test is SKIPPED (not failed). Import directly:
 * `import { test, expect } from '@fixtures/mobileFixtures'`.
 */
export const test = base.extend<MobileOptions & MobileFixtures>({
  mobile: [undefined, { option: true }],

  maestro: async ({ mobile }, use, testInfo) => {
    const platform = resolvePlatform(mobile);
    const deviceName = mobile?.device || process.env.MOBILE_DEVICE || undefined;
    const device = await new DeviceManager().acquire(platform, deviceName);
    if (!device) {
      testInfo.skip(
        true,
        `[mobile] no booted ${platform} device — set MOBILE_DEVICE (or test.use({ mobile: { device } })) ` +
          'to auto-boot one, or boot a device manually. See docs/MOBILE_TESTING.md'
      );
      return;
    }

    const runner = new MaestroRunner();
    await use({
      device,
      run: async (flowPath, options) => {
        const result = await runner.run(flowPath, {
          device: device.id,
          platform: device.platform,
          outputDir: testInfo.outputDir,
          tags: options?.tags,
        });

        // Bridge Maestro artifacts into the Playwright report (attached even on failure).
        if (fs.existsSync(result.junitPath)) {
          await testInfo.attach('maestro-junit', {
            path: result.junitPath,
            contentType: 'application/xml',
          });
        }
        for (const png of screenshots(result.outputDir)) {
          await testInfo.attach(path.basename(png), { path: png, contentType: 'image/png' });
        }

        if (result.exitCode !== 0) {
          const tail = result.stderr.trim().split('\n').slice(-20).join('\n');
          throw new Error(`[maestro] ${flowPath} failed (exit ${result.exitCode})\n${tail}`);
        }
      },
    });
  },
});

export { expect };
