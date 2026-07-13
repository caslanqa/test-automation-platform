import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  adbPath,
  avdNameForSerial,
  bootAndroidAvd,
  emulatorMode,
  listAvds,
  shutdownEmulator,
} from './android';
import { bootIosSim, openSimulatorApp, quitSimulatorApp, resolveSimUdid } from './ios';
import type { DiscoveredDevice, MobilePlatform } from './types';

const execFileAsync = promisify(execFile);

/**
 * Layer 1 — device acquisition. Maestro remains responsible for device COMMUNICATION; this finds a
 * booted device for the platform (optionally a specific one by name) so Maestro can target it — and,
 * when a named device isn't booted yet, boots it and waits (auto-boot). Booted devices are left
 * running (reused across runs). MVP: single device, serial — no pool, no locking, no auto-shutdown.
 */
export class DeviceManager {
  /**
   * Acquire a device for `platform`, in the requested `headless` mode (default true = hidden).
   * - With `deviceName` (Android AVD name, or iOS simulator name/UDID): reuse it if already booted,
   *   otherwise BOOT it and wait until ready.
   * - Without `deviceName`: return the first booted device, or `null` (the fixture then skips).
   *
   * `headless` always takes effect on a reused device, so it can be flipped per test:
   * - iOS toggles the Simulator app (open = headed, quit = headless) — the booted runtime is untouched.
   * - Android's window is fixed at boot, so when a framework-booted emulator is running in the other
   *   mode it's restarted; a match, or an externally-booted emulator (unknown mode), is reused as-is.
   */
  async acquire(
    platform: MobilePlatform,
    deviceName?: string,
    headless = true
  ): Promise<DiscoveredDevice | null> {
    const existing = await this.findBooted(platform, deviceName);
    if (existing) {
      if (platform === 'ios') {
        await (headless ? quitSimulatorApp() : openSimulatorApp());
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
      if (!listAvds().includes(deviceName)) {
        return null;
      }
      await bootAndroidAvd(deviceName, headless);
    } else {
      if (!(await resolveSimUdid(deviceName))) {
        return null;
      }
      await bootIosSim(deviceName);
      await (headless ? quitSimulatorApp() : openSimulatorApp());
    }
    return this.findBooted(platform, deviceName);
  }

  /** First booted device for the platform, matching `deviceName` when provided. */
  private async findBooted(
    platform: MobilePlatform,
    deviceName?: string
  ): Promise<DiscoveredDevice | null> {
    return platform === 'android'
      ? this.findBootedAndroid(deviceName)
      : this.findBootedIos(deviceName);
  }

  /** Parse `adb devices` for a serial in state `device` (matching the AVD name if requested). */
  private async findBootedAndroid(deviceName?: string): Promise<DiscoveredDevice | null> {
    const out = await capture(adbPath(), ['devices']);
    if (out === null) {
      return null;
    }
    for (const line of out.split('\n').slice(1)) {
      const [id, state] = line.trim().split(/\s+/);
      if (!id || state !== 'device') {
        continue;
      }
      if (deviceName) {
        if ((await avdNameForSerial(id)) === deviceName) {
          return { id, platform: 'android', name: deviceName };
        }
        continue;
      }
      return { id, platform: 'android', name: id };
    }
    return null;
  }

  /** Parse `xcrun simctl list devices booted -j` (matching name/UDID if requested). */
  private async findBootedIos(deviceName?: string): Promise<DiscoveredDevice | null> {
    const out = await capture('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
    if (out === null) {
      return null;
    }
    try {
      const data = JSON.parse(out) as {
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
}

/** Run a command and return its stdout, or `null` if the binary is missing or it exits non-zero. */
function capture(cmd: string, args: string[]): Promise<string | null> {
  return execFileAsync(cmd, args, { timeout: 10_000 })
    .then(r => r.stdout)
    .catch(() => null);
}
