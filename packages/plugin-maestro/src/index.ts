/**
 * @pwtap/plugin-maestro — mobile testing for Playwright via Maestro. One `maestro` fixture offers two
 * authoring styles, mixable in a single test: an imperative Playwright-style API
 * (`maestro.tapOn(...)`, `maestro.assertVisible(...)`) backed by a warm `maestro mcp` driver, and
 * batch YAML flows (`maestro.run('flows/login.yaml')`). Android + iOS simulator, macOS-first; device
 * discovery/boot/lock come from `@pwtap/platform`.
 */
export { expect, test } from './fixture.js';
export type { MaestroFixture, MobileOptions } from './fixture.js';

export { devices, type DeviceSpec } from './devices.js';
export { stopBootedDevices } from './teardown.js';

// Advanced surface — the adapters behind the fixture, for bespoke wiring.
export type { DiscoveredDevice, MobilePlatform } from '@pwtap/platform';
export { maestroError } from './core/maestroError.js';
export {
  MaestroMcpSession,
  resolveScreenshotMode,
  type MaestroDirection,
  type McpSessionHooks,
  type ScreenshotMode,
} from './core/MaestroMcpSession.js';
export { MaestroRunner, maestroSupportsParallel } from './core/MaestroRunner.js';
export { McpClient, type McpToolResult } from './core/McpClient.js';
export { findNode, flattenScreen, rowValue } from './core/screen.js';
export type {
  MaestroNode,
  MaestroRunOptions,
  MaestroRunResult,
  MaestroScreen,
  MaestroSelector,
} from './core/types.js';
