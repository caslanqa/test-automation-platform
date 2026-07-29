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
import { listAvds, listBootedAndroidDevices, listIosSimulators } from '@pwtap/platform';

import type { InspectorDevice } from './types.js';

/** What to write into a generated test's `mobileTarget.device`, and whether it is actually durable. */
export interface StableDeviceName {
  device: string;
  /** Set when the returned value is NOT durable, so the caller can tell the user instead of hiding it. */
  warning?: string;
}

/**
 * Resolve the device handle a generated test should pin, given the connected device and the devices
 * discovery knows about.
 *
 * The value is replayed days later, so it must survive a reboot — which rules out the handle discovery
 * mostly reports for a *booted* device. Per platform:
 *
 * - **Android:** the AVD name. AVD names are unique by construction (they are directory names), so the
 *   name is both stable and unambiguous. When discovery could not determine one, all we have is the `adb`
 *   serial (`emulator-5554`), which is gone after a reboot — returned with a warning rather than silently
 *   baked into a test that will mysteriously stop matching a device.
 * - **iOS:** the simulator name when it is unique among known simulators, because it reads far better in a
 *   test than a UUID. Simulator names are NOT unique (two "iPhone 15" runtimes are perfectly legal), so an
 *   ambiguous name falls back to the UDID, which is stable across reboots and unambiguous by definition.
 *
 * Lives here, beside discovery, so the recorder (which writes the value) and the fixture (which resolves
 * it back to a device) cannot drift apart on what a `device` string means. See ADR-003.
 */
export function resolveStableDeviceName(
  connected: InspectorDevice,
  known: readonly InspectorDevice[],
): StableDeviceName {
  if (connected.platform === 'android') {
    if (connected.name && connected.name !== connected.id) {
      return { device: connected.name };
    }
    return {
      device: connected.id,
      warning:
        `no AVD name could be resolved for "${connected.id}", so the generated test pins that ` +
        'serial — it will not match the device after a reboot. Edit `mobileTarget.device` to the AVD name.',
    };
  }

  const sameName = known.filter(d => d.platform === 'ios' && d.name === connected.name);
  if (sameName.length === 1) {
    return { device: connected.name };
  }
  if (sameName.length > 1) {
    return {
      device: connected.id,
      warning:
        `more than one iOS simulator is named "${connected.name}", so the generated test pins the ` +
        'UDID instead to stay unambiguous.',
    };
  }
  // Discovery told us nothing about this simulator, so uniqueness is unverifiable. The UDID is
  // unambiguous by definition; a name that turns out to be shared would silently target the wrong device.
  return {
    device: connected.id,
    warning:
      'could not list iOS simulators to check whether the device name is unique, so the generated ' +
      'test pins the UDID.',
  };
}

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
