import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getPlatform } from '../platform.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** List installed AVD names (`emulator -list-avds`), or `[]` if the emulator tool is unavailable. */
export async function listAvds(): Promise<string[]> {
  const platform = getPlatform();
  const { stdout, code } = await platform.run(platform.emulatorPath(), ['-list-avds'], {
    timeoutMs: 10_000,
    env: platform.androidEnv(),
  });
  if (code !== 0) {
    return [];
  }
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/** The AVD name backing a booted emulator serial (`adb -s <serial> emu avd name`), or `undefined`. */
export async function avdNameForSerial(serial: string): Promise<string | undefined> {
  const platform = getPlatform();
  const { stdout, code } = await platform.run(
    platform.adbPath(),
    ['-s', serial, 'emu', 'avd', 'name'],
    { timeoutMs: 5_000, env: platform.androidEnv() },
  );
  if (code !== 0) {
    return undefined;
  }
  // Output is the AVD name on the first line, then `OK`.
  return stdout.split('\n')[0]?.trim() || undefined;
}

// An emulator's window mode (`-no-window` or not) is fixed at boot and can't change on a running
// instance. We record the mode we booted each AVD in (in a temp file cleared on reboot) so a reused
// emulator can be restarted when a test asks for the other mode (see acquireDevice).

function modeMarker(avdName: string): string {
  return path.join(os.tmpdir(), `pw-ai-emu-${avdName.replace(/[^A-Za-z0-9_.-]/g, '_')}.mode`);
}

function recordEmulatorMode(avdName: string, headless: boolean): void {
  try {
    fs.writeFileSync(modeMarker(avdName), headless ? 'headless' : 'headed');
  } catch {
    /* best-effort — a missing marker just means "reuse as-is" later */
  }
}

/** The mode the framework last booted an AVD in, or `undefined` if unknown (e.g. booted externally). */
export function emulatorMode(avdName: string): 'headed' | 'headless' | undefined {
  try {
    const value = fs.readFileSync(modeMarker(avdName), 'utf8').trim();
    return value === 'headed' || value === 'headless' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Shut down a booted emulator by serial and wait until it leaves `adb devices`. */
export async function shutdownEmulator(serial: string): Promise<void> {
  const platform = getPlatform();
  const env = platform.androidEnv();
  const adb = platform.adbPath();
  await platform.run(adb, ['-s', serial, 'emu', 'kill'], { timeoutMs: 10_000, env });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { stdout } = await platform.run(adb, ['devices'], { timeoutMs: 5_000, env });
    if (!stdout.split('\n').some(line => line.startsWith(serial))) {
      return;
    }
    await sleep(1_000);
  }
}

/** The emulator serial currently running `avdName`, or `undefined`. */
async function serialForAvd(avdName: string): Promise<string | undefined> {
  const platform = getPlatform();
  const { stdout } = await platform.run(platform.adbPath(), ['devices'], {
    timeoutMs: 5_000,
    env: platform.androidEnv(),
  });
  for (const line of stdout.split('\n').slice(1)) {
    const id = line.trim().split(/\s+/)[0];
    if (id && (await avdNameForSerial(id)) === avdName) {
      return id;
    }
  }
  return undefined;
}

/**
 * Boot an Android AVD by name and wait until it's ready to run a flow. Launches the emulator detached
 * (so it outlives the test process — booted devices are reused, not shut down), then waits for the
 * device to be genuinely ready: `sys.boot_completed=1` AND the package manager able to resolve a
 * package. The `pm` gate matters because `boot_completed` fires seconds before `pm` can install APKs.
 * Throws with an actionable message if the AVD is missing or the boot times out.
 */
export async function bootAndroidAvd(
  avdName: string,
  headless = true,
  timeoutMs = 180_000,
): Promise<void> {
  const platform = getPlatform();
  const avds = await listAvds();
  if (!avds.includes(avdName)) {
    throw new Error(
      `[pwtap] AVD '${avdName}' not found${
        avds.length ? ` (have: ${avds.join(', ')})` : ' — is the Android SDK installed?'
      }`,
    );
  }

  // The emulator shows a window by default; `-no-window` runs it headless.
  const child = spawn(
    platform.emulatorPath(),
    ['-avd', avdName, ...(headless ? ['-no-window'] : [])],
    {
      detached: true,
      stdio: 'ignore',
      env: platform.androidEnv(),
    },
  );
  child.unref();
  recordEmulatorMode(avdName, headless);

  const adb = platform.adbPath();
  const env = platform.androidEnv();
  const sh = async (args: string[]): Promise<string> =>
    (await platform.run(adb, args, { timeoutMs: 5_000, env })).stdout;

  const deadline = Date.now() + timeoutMs;
  let serial: string | undefined;
  while (Date.now() < deadline) {
    // Resolve THIS AVD's serial first: with several emulators booting in parallel a bare `adb shell`
    // is ambiguous, so readiness must be checked on the serial with `-s`.
    serial ??= await serialForAvd(avdName);
    if (serial) {
      const bootCompleted =
        (await sh(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'])).trim() === '1';
      const pmReady =
        bootCompleted &&
        (await sh(['-s', serial, 'shell', 'pm', 'path', 'android'])).includes('package:');
      if (pmReady) {
        return;
      }
    }
    await sleep(2_000);
  }
  throw new Error(`[pwtap] AVD '${avdName}' did not finish booting within ${timeoutMs / 1000}s`);
}
