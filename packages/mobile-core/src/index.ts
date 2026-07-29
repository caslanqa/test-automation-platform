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
  MIN_ADAPTER_CONTRACT,
  MOBILE_CORE_CONTRACT,
  adapterContractProblem,
  type AdapterContract,
} from './contract.js';
export { ACTION_DEFAULTS } from './defaults.js';
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
  outOfAppWarning,
  resolveTargetPoint,
} from './locator.js';
export { assignNodeIdentity, findNodeByKey } from './nodeIdentity.js';
export { discoverDriverMap, discoverDrivers, type AdapterProblemReporter } from './registry.js';
export * from './types.js';

/**
 * `@pwtap/platform` device/app helpers, re-exported so the inspector's device and app pickers have one
 * import site for them. Plain re-exports: `@pwtap/platform` is a direct dependency of this package with a
 * caret range, so npm resolves a version that has them — the runtime "is this export a function?" bridge
 * that used to sit here treated a versioning problem as a runtime problem (ADR-009).
 */
export {
  listAvds,
  listBootedAndroidDevices,
  listInstalledAndroidApps,
  listInstalledIosApps,
  listIosSimulators,
  resolveSimUdid,
} from '@pwtap/platform';
