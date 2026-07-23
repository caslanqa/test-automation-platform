import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DiscoveredDevice } from '../types.js';
import { shutdownEmulator } from './android.js';
import { shutdownSim } from './ios.js';

// Records the devices THIS run auto-booted (not reused ones), so a teardown can shut them down —
// leaving devices you booted yourself untouched. A file in tmp (cleared on OS reboot) shared between
// the test workers (which record) and the main process (which tears down). Mobile runs serial, so no
// concurrent writers. Shared across mobile engines (Maestro, Appium, …) — the file name predates
// multi-engine support but is otherwise engine-neutral.
const SESSION_FILE = path.join(os.tmpdir(), 'pwtap-mobile-booted.jsonl');

/** Devices the framework booted this run. */
export function readBootedDevices(): DiscoveredDevice[] {
  try {
    return fs
      .readFileSync(SESSION_FILE, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as DiscoveredDevice);
  } catch {
    return [];
  }
}

/** Record a device the framework just booted (deduped by platform + id). Best-effort. */
export function recordBootedDevice(device: DiscoveredDevice): void {
  try {
    const already = readBootedDevices().some(
      d => d.id === device.id && d.platform === device.platform,
    );
    if (already) {
      return;
    }
    fs.appendFileSync(
      SESSION_FILE,
      `${JSON.stringify({ id: device.id, platform: device.platform })}\n`,
    );
  } catch {
    /* best-effort — a missing record just means teardown won't shut this device down */
  }
}

/** Clear the booted-devices record (after teardown). */
export function clearBootedDevices(): void {
  try {
    fs.rmSync(SESSION_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Shut down the devices the framework AUTO-BOOTED this run (recorded via `recordBootedDevice`) so
 * emulators/simulators don't linger. Devices booted by hand are never recorded, so they're left
 * running. Pass `keepDevices: true` (an engine's own `*_KEEP_DEVICES` env var) to skip the actual
 * shutdown but still clear the record — useful for fast iterative reruns. A no-op when nothing was
 * booted.
 */
export async function stopBootedDevices(options: { keepDevices?: boolean } = {}): Promise<void> {
  const booted = readBootedDevices();
  if (booted.length === 0) {
    return;
  }
  if (!options.keepDevices) {
    for (const device of booted) {
      if (device.platform === 'android') {
        await shutdownEmulator(device.id);
      } else {
        await shutdownSim(device.id);
      }
    }
  }
  clearBootedDevices();
}
