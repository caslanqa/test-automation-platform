/**
 * `@pwtap/mobile-core` — the driver-neutral mobile contracts, and the only mobile package a *test* ever
 * loads at runtime.
 *
 * Everything here is what a generated or hand-written mobile test and a driver adapter genuinely need:
 * the action IR and types, the locator engine, device discovery, the `./inspector` adapter registry, and
 * the `mobileApp` Playwright fixture. The recording application — service, UI, code generator, CLI — lives
 * in `@pwtap/mobile-inspector`, which is a development tool and deliberately absent from this graph: the
 * adapters only ever imported the types plus three pure helpers from it, while it dragged Electron and a
 * duplicate Prettier into every client install. See docs/mobile-inspector/architecture.md ADR-008.
 */
export {
  discoverMobileDevices,
  resolveStableDeviceName,
  type StableDeviceName,
} from './deviceDiscovery.js';
export { expect, test, type MobileInspectorOptions, type MobileTargetOptions } from './fixture.js';
export { readImageSize } from './imageSize.js';
export {
  centerOf,
  countMatches,
  findNode,
  hitTest,
  locatorCandidates,
  locatorForNode,
  resolveTargetPoint,
} from './locator.js';
export { discoverDriverMap, discoverDrivers } from './registry.js';
export * from './types.js';

/**
 * `@pwtap/platform` device/app helpers, re-exported through the compatibility bridge in
 * `platformCompat.ts` so an outdated platform install fails with a clear upgrade message instead of
 * crashing module load on a missing named export. The inspector's app picker needs them; they live here
 * rather than being imported from `@pwtap/platform` directly so the whole mobile stack has exactly one
 * compatibility point. ADR-009 replaces this with a declared contract version and deletes the bridge.
 */
export {
  listAvds,
  listBootedAndroidDevices,
  listInstalledAndroidApps,
  listInstalledIosApps,
  listIosSimulators,
  resolveSimUdid,
} from './platformCompat.js';
