/**
 * `@pwtap/mobile-inspector` — public entry point.
 *
 * Exports the shared driver-neutral contracts (Phase 1), the driver adapter registry, and the
 * unified `MobileApp` Playwright fixture (`test`/`expect`). Maestro/Appium `./inspector` adapters
 * (Phase 2) and the local recording service/UI/codegen (Phase 3/4) build on these.
 */
export { discoverMobileDevices } from './deviceDiscovery.js';
export { expect, test, type MobileInspectorOptions } from './fixture.js';
export { readImageSize } from './imageSize.js';
export {
  centerOf,
  countMatches,
  findNode,
  locatorCandidates,
  resolveTargetPoint,
} from './locator.js';
export { discoverDriverMap, discoverDrivers } from './registry.js';
export * from './types.js';
