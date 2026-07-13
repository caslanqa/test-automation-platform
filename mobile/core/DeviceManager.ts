import { execFile } from 'child_process';
import { promisify } from 'util';

import { adbPath, avdNameForSerial, bootAndroidAvd } from './android';
import { bootIosSim } from './ios';
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
   * Acquire a device for `platform`.
   * - With `deviceName` (Android AVD name, or iOS simulator name/UDID): reuse it if already booted,
   *   otherwise BOOT it and wait until ready.
   * - Without `deviceName`: return the first booted device, or `null` (the fixture then skips).
   */
  async acquire(platform: MobilePlatform, deviceName?: string): Promise<DiscoveredDevice | null> {
    const existing = await this.findBooted(platform, deviceName);
    if (existing) {
      return existing;
    }
    if (!deviceName) {
      return null; // nothing booted and nothing named to boot → caller skips gracefully
    }

    if (platform === 'android') {
      await bootAndroidAvd(deviceName);
    } else {
      await bootIosSim(deviceName);
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
