/**
 * @pwtap/platform — the single OS seam for Playwright Test Automation Platform plugins.
 *
 * All OS-specific commands/paths (Android SDK, iOS simulator, device discovery/boot) and the
 * cross-process device lock live here. Today only macOS is implemented; adding another OS means
 * adding one `Platform` implementation and one branch in `getPlatform()` — no plugin/core changes.
 */

export { MacPlatform, getPlatform, setPlatform } from './platform.js';
export type {
  DiscoveredDevice,
  MobilePlatform,
  OsId,
  Platform,
  RunOptions,
  RunResult,
} from './types.js';

export {
  avdNameForSerial,
  bootAndroidAvd,
  emulatorMode,
  listAvds,
  shutdownEmulator,
} from './device/android.js';
export { acquireDevice, findBootedDevice, type AcquireOptions } from './device/discover.js';
export {
  bootIosSim,
  openSimulatorApp,
  quitSimulatorApp,
  resolveSimUdid,
  shutdownSim,
} from './device/ios.js';
export { acquireDeviceLock, deviceLockKey } from './device/lock.js';
