import { getPlatform } from '../platform.js';
import type { DiscoveredDevice, MobilePlatform } from '../types.js';
import {
  avdNameForSerial,
  bootAndroidAvd,
  emulatorMode,
  listAvds,
  shutdownEmulator,
} from './android.js';
import { bootIosSim, resolveSimUdid } from './ios.js';

export interface AcquireOptions {
  /** Android AVD name, or iOS simulator name/UDID. When omitted, reuse the first booted device. */
  deviceName?: string;
  /** Hidden (default true) vs. visible device window. Applied even to a reused device. */
  headless?: boolean;
  /**
   * Called when THIS acquisition BOOTED a device (vs. reused one already running), so a plugin can
   * record it for teardown. Devices you booted yourself are never reported here.
   */
  onBooted?: (device: DiscoveredDevice) => void;
}

/** First booted device for the platform, matching `deviceName` when provided. */
export async function findBootedDevice(
  platform: MobilePlatform,
  deviceName?: string,
): Promise<DiscoveredDevice | null> {
  return platform === 'android' ? findBootedAndroid(deviceName) : findBootedIos(deviceName);
}

async function findBootedAndroid(deviceName?: string): Promise<DiscoveredDevice | null> {
  const p = getPlatform();
  const { stdout, code } = await p.run(p.adbPath(), ['devices'], {
    timeoutMs: 10_000,
    env: p.androidEnv(),
  });
  if (code !== 0) {
    return null;
  }
  for (const line of stdout.split('\n').slice(1)) {
    const [id, state] = line.trim().split(/\s+/);
    if (!id || state !== 'device') {
      continue;
    }
    if (deviceName) {
      if (id === deviceName || (await avdNameForSerial(id)) === deviceName) {
        return { id, platform: 'android', name: deviceName };
      }
      continue;
    }
    return { id, platform: 'android', name: id };
  }
  return null;
}

async function findBootedIos(deviceName?: string): Promise<DiscoveredDevice | null> {
  const p = getPlatform();
  const { stdout, code } = await p.simctl(['list', 'devices', 'booted', '-j'], {
    timeoutMs: 10_000,
  });
  if (code !== 0) {
    return null;
  }
  try {
    const data = JSON.parse(stdout) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
    };
    const booted = Object.values(data.devices ?? {})
      .flat()
      .filter(d => d.state === 'Booted' && d.udid);
    const match = deviceName
      ? booted.find(d => d.udid === deviceName || d.name === deviceName)
      : booted[0];
    if (match?.udid) {
      return { id: match.udid, platform: 'ios', name: match.name };
    }
  } catch {
    // Unexpected simctl output — treat as "no device".
  }
  return null;
}

/**
 * Acquire a device for `platform`. Reuse a matching booted device if present (flipping headed/headless
 * as requested); otherwise boot the named device and wait until ready. Returns `null` when nothing is
 * booted and nothing was named to boot (the caller then skips gracefully) — this never hard-fails on a
 * missing device. Shared by every mobile plugin so Maestro and Appium acquire devices identically.
 */
export async function acquireDevice(
  platform: MobilePlatform,
  opts: AcquireOptions = {},
): Promise<DiscoveredDevice | null> {
  const { deviceName, headless = true, onBooted } = opts;
  const p = getPlatform();

  const existing = await findBootedDevice(platform, deviceName);
  if (existing) {
    if (platform === 'ios') {
      await (headless ? p.quitSimulatorApp() : p.openSimulatorApp());
      return existing;
    }
    const current = deviceName ? emulatorMode(deviceName) : undefined;
    if (current && current !== (headless ? 'headless' : 'headed')) {
      await shutdownEmulator(existing.id); // wrong mode → restart below so `headless` takes effect
    } else {
      return existing;
    }
  }

  if (!deviceName) {
    return null; // nothing booted and nothing named to boot → caller skips gracefully
  }

  // A device was named but isn't booted. Boot it if it EXISTS; if it doesn't, return null so the
  // caller skips (with a "create it" hint) instead of hard-failing on a missing AVD/simulator.
  if (platform === 'android') {
    if (!(await listAvds()).includes(deviceName)) {
      return null;
    }
    await bootAndroidAvd(deviceName, headless);
  } else {
    if (!(await resolveSimUdid(deviceName))) {
      return null;
    }
    await bootIosSim(deviceName);
    await (headless ? p.quitSimulatorApp() : p.openSimulatorApp());
  }

  const booted = await findBootedDevice(platform, deviceName);
  if (booted) {
    onBooted?.(booted); // we booted it (vs reused) → let the caller record it for teardown
  }
  return booted;
}
