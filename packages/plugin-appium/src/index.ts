/**
 * @pwtap/plugin-appium — mobile testing for Playwright via Appium. One `appium` selection option and
 * an `app` fixture expose the raw WebdriverIO session — no curated facade — over the W3C WebDriver
 * protocol against a booted device. Android (UiAutomator2) + iOS simulator (XCUITest), macOS-first;
 * device discovery/boot/lock come from `@pwtap/platform`, shared with `@pwtap/plugin-maestro`.
 */
export { expect, test } from './fixture.js';
export type { AppiumApp, AppiumOptions } from './fixture.js';

export { devices, type DeviceSpec } from './devices.js';
export { stopBootedDevices } from './teardown.js';

// Advanced surface — the adapters behind the fixture, for bespoke wiring.
export type { DiscoveredDevice, MobilePlatform } from '@pwtap/platform';
export { resolveAppArtifact } from './core/appArtifact.js';
export {
  assertPlatformSupported,
  ensureAppiumServer,
  type AppiumServerHandle,
} from './core/appiumServer.js';
export { buildCapabilities, type AppiumCapabilityOptions } from './core/caps.js';
export { closeSession, createSession, type AppiumSessionOptions } from './core/session.js';
