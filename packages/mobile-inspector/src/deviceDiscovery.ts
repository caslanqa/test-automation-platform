/**
 * Shared device-discovery helper for driver adapters (Phase 2). Both the Maestro and Appium
 * adapters need the identical "known devices" list (installed Android AVDs + iOS simulators, with
 * real live/booted status) — implemented once here rather than duplicated in each `./inspector`
 * module, per `plan.md`'s "do not duplicate device discovery logic" constraint.
 *
 * Real-time "booted" status comes from `listBootedAndroidDevices`/`listIosSimulators` (live OS
 * queries), NOT `readBootedDevices` (the framework's own boot registry, which only reflects devices
 * a framework run booted itself — irrelevant for a device PICKER that must also show devices booted
 * outside the framework, e.g. manually via Android Studio/Xcode).
 */
import { listAvds, listBootedAndroidDevices, listIosSimulators } from './platformCompat.js';

import type { InspectorDevice } from './types.js';

export async function discoverMobileDevices(): Promise<InspectorDevice[]> {
  const devices: InspectorDevice[] = [];

  const [avds, bootedAndroid, sims] = await Promise.all([
    listAvds(),
    listBootedAndroidDevices(),
    listIosSimulators(),
  ]);

  const bootedAvdNames = new Set(
    bootedAndroid.map(d => d.avdName).filter((name): name is string => Boolean(name)),
  );
  // Booted emulators first, addressed by their real adb serial (what a session must connect to).
  for (const { serial, avdName } of bootedAndroid) {
    devices.push({ id: serial, name: avdName ?? serial, platform: 'android', booted: true });
  }
  for (const name of avds) {
    if (!bootedAvdNames.has(name)) {
      devices.push({ id: name, name, platform: 'android', booted: false });
    }
  }

  for (const sim of sims) {
    devices.push({ id: sim.udid, name: sim.name, platform: 'ios', booted: sim.booted });
  }

  return devices;
}
