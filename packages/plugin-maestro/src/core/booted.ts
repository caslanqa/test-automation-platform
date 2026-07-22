import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DiscoveredDevice } from '@pwtap/platform';

// Records the devices THIS run auto-booted (not reused ones), so globalTeardown can shut them down —
// leaving devices you booted yourself untouched. A file in tmp (cleared on OS reboot) shared between
// the test workers (which record) and the main process (which tears down). Mobile runs serial, so no
// concurrent writers.
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
