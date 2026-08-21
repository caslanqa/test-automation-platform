/**
 * @pwtap/platform — the single OS seam for Playwright Test Automation Platform plugins.
 *
 * All OS-specific commands/paths (Android SDK, iOS simulator, device discovery/boot) and the
 * cross-process device lock live here. macOS drives both Android and iOS; Linux drives Android (iOS
 * simulators do not exist off macOS). Adding another OS means adding one `Platform` implementation and one
 * branch in `getPlatform()` — no plugin/core changes.
 */

export { LinuxPlatform, MacPlatform, getPlatform, setPlatform } from './platform.js';
export type {
  DiscoveredDevice,
  MobilePlatform,
  OsId,
  Platform,
  RunOptions,
  RunResult,
  ScreenRecording,
} from './types.js';

export {
  avdNameForSerial,
  bootAndroidAvd,
  clearLogcat,
  dumpLogcat,
  emulatorMode,
  foregroundAndroidApp,
  getAndroidViewportSize,
  listAvds,
  listBootedAndroidDevices,
  listInstalledAndroidApps,
  shutdownEmulator,
  startAndroidRecording,
} from './device/android.js';
export {
  clearBootedDevices,
  readBootedDevices,
  recordBootedDevice,
  stopBootedDevices,
} from './device/booted.js';
export { acquireDevice, findBootedDevice, type AcquireOptions } from './device/discover.js';
export {
  bootIosSim,
  dumpSimLog,
  getIosSimulatorViewportSize,
  listInstalledIosApps,
  listIosSimulators,
  logCaptureStart,
  openSimulatorApp,
  quitSimulatorApp,
  resolveSimUdid,
  shutdownSim,
  startSimRecording,
  stopIosAutomation,
} from './device/ios.js';
export { acquireDeviceLock, deviceLockKey, type DeviceLockOptions } from './device/lock.js';
