/**
 * The message a test gets when the device it pins is not on this machine.
 *
 * A recording pins a device by name so it is reproducible (ADR-003), which means the very first thing that
 * happens on a colleague's laptop or in CI is that the name does not resolve. The adapters used to answer
 * `no android device available to connect the inspector to`: it named neither the device asked for nor the
 * ones present, said nothing about how to proceed, and mentioned the inspector during a plain test run.
 *
 * @example await deviceUnavailableMessage('maestro', 'android', 'pixel9')
 */
import type { MobilePlatform } from '@pwtap/platform';

import { discoverMobileDevices } from './deviceDiscovery.js';

/** How to create what is missing, per platform. */
const CREATE_HINT: Record<MobilePlatform, string> = {
  android: 'create it in Android Studio > Device Manager, or `avdmanager create avd`',
  ios: 'create it in Xcode > Windows > Devices and Simulators, or `xcrun simctl create`',
};

/**
 * Explain why no device could be acquired, naming the request and listing what this machine actually has.
 * Falls back to a plain sentence if discovery itself fails — a diagnostic must not throw over a diagnostic.
 */
export async function deviceUnavailableMessage(
  driverId: string,
  platform: MobilePlatform,
  requested: string | undefined,
): Promise<string> {
  let available: string[] = [];
  try {
    available = listFor(platform, await discoverMobileDevices());
  } catch {
    // Discovery is best-effort here; the caller still needs an answer.
  }

  const prefix = `[${driverId}] `;
  if (!requested) {
    return available.length > 0
      ? `${prefix}no ${platform} device is running, and none was named. Boot one of: ${available.join(', ')} — ` +
          `or set \`mobileTarget.device\` (or MOBILE_INSPECTOR_DEVICE) to start one automatically.`
      : `${prefix}no ${platform} device is running and this machine has none — ${CREATE_HINT[platform]}.`;
  }
  return available.length > 0
    ? `${prefix}${platform} device "${requested}" was not found on this machine. Available: ` +
        `${available.join(', ')}. Point \`mobileTarget.device\` at one of those, override it with ` +
        `MOBILE_INSPECTOR_DEVICE=<name>, or ${CREATE_HINT[platform]}.`
    : `${prefix}${platform} device "${requested}" was not found, and this machine has no ${platform} ` +
        `devices at all — ${CREATE_HINT[platform]}.`;
}

/** How many names to list before summarising: a machine can have forty simulators, and a wall of them helps nobody. */
const MAX_LISTED = 8;

/**
 * Device names worth showing: booted first (they need no boot), deduplicated by name, and capped. Simulator
 * names repeat across runtimes — six "iPhone 17 Pro" entries are one choice to a reader, not six.
 */
function listFor(
  platform: MobilePlatform,
  devices: readonly { name: string; platform: MobilePlatform; booted: boolean }[],
): string[] {
  const seen = new Set<string>();
  const named: string[] = [];
  for (const device of [...devices].sort((a, b) => Number(b.booted) - Number(a.booted))) {
    if (device.platform !== platform || seen.has(device.name)) {
      continue;
    }
    seen.add(device.name);
    named.push(`${device.name}${device.booted ? ' (booted)' : ''}`);
  }
  return named.length > MAX_LISTED
    ? [...named.slice(0, MAX_LISTED), `and ${named.length - MAX_LISTED} more`]
    : named;
}
