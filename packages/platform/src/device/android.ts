import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getPlatform } from '../platform.js';
import type { ScreenRecording } from '../types.js';

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

/**
 * Every currently-online Android device/emulator (`adb devices`), regardless of whether THIS
 * framework booted it — unlike the `booted.json` registry (`readBootedDevices`), which only tracks
 * devices booted by a framework run and is meant for its own teardown, not general live status. Use
 * this when you need the real OS-level picture (e.g. a device picker), such as the Mobile Inspector.
 */
export async function listBootedAndroidDevices(): Promise<
  Array<{ serial: string; avdName?: string }>
> {
  const platform = getPlatform();
  const { stdout, code } = await platform.run(platform.adbPath(), ['devices'], {
    timeoutMs: 10_000,
    env: platform.androidEnv(),
  });
  if (code !== 0) {
    return [];
  }
  const serials = stdout
    .split('\n')
    .slice(1) // header line: "List of devices attached"
    .map(line => line.trim())
    .filter(line => line.endsWith('\tdevice'))
    .map(line => line.split('\t')[0]);
  return Promise.all(
    serials.map(async serial => ({ serial, avdName: await avdNameForSerial(serial) })),
  );
}

/** Visible Android display size used by accessibility bounds and pointer actions. */
export async function getAndroidViewportSize(
  serial: string,
): Promise<{ width: number; height: number } | undefined> {
  const platform = getPlatform();
  const { stdout, code } = await platform.run(
    platform.adbPath(),
    ['-s', serial, 'shell', 'wm', 'size'],
    { timeoutMs: 10_000, env: platform.androidEnv() },
  );
  if (code !== 0) {
    return undefined;
  }
  const matches = [...stdout.matchAll(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)];
  const match = matches.find(item => item[0].startsWith('Override')) ?? matches[0];
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

/**
 * List packages installed on a booted Android device (`adb -s <serial> shell pm list packages`).
 * When `thirdPartyOnly` is true (default) system/OS packages are excluded (`-3`) so the app picker
 * shows the user's own installed apps first. Returns package names; the OS provides no display label
 * here, so callers use the package id as the label. Empty on any failure (best-effort).
 */
export async function listInstalledAndroidApps(
  serial: string,
  thirdPartyOnly = true,
): Promise<Array<{ id: string; system: boolean }>> {
  const platform = getPlatform();
  const args = ['-s', serial, 'shell', 'pm', 'list', 'packages'];
  if (thirdPartyOnly) {
    args.push('-3');
  }
  const { stdout, code } = await platform.run(platform.adbPath(), args, {
    timeoutMs: 15_000,
    env: platform.androidEnv(),
  });
  if (code !== 0) {
    return [];
  }
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('package:'))
    .map(line => ({ id: line.slice('package:'.length).trim(), system: !thirdPartyOnly }))
    .filter(app => app.id.length > 0);
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

/** Clear the device's logcat buffer — call before a capture window begins. Best-effort. */
export async function clearLogcat(serial: string): Promise<void> {
  const platform = getPlatform();
  await platform.run(platform.adbPath(), ['-s', serial, 'logcat', '-c'], {
    timeoutMs: 10_000,
    env: platform.androidEnv(),
  });
}

/** Dump everything logcat has captured since the last {@link clearLogcat}. */
export async function dumpLogcat(serial: string): Promise<string> {
  const platform = getPlatform();
  const { stdout } = await platform.run(platform.adbPath(), ['-s', serial, 'logcat', '-d'], {
    timeoutMs: 30_000,
    env: platform.androidEnv(),
  });
  return stdout;
}

/**
 * Start recording the device's screen via `adb shell screenrecord`, capped at 3 minutes (Android's
 * own safety limit — a forgotten {@link ScreenRecording.stop} still self-terminates rather than
 * filling device storage). Returns `undefined` on any spawn failure (best-effort, never throws).
 */
export function startAndroidRecording(
  serial: string,
  outputPath: string,
): ScreenRecording | undefined {
  const platform = getPlatform();
  const env = platform.androidEnv();
  const remotePath = `/sdcard/pwtap-rec-${Date.now()}.mp4`;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      platform.adbPath(),
      ['-s', serial, 'shell', 'screenrecord', '--time-limit', '180', remotePath],
      { env, stdio: 'ignore' },
    );
    child.on('error', () => {
      /* surfaced via stop()'s pulled-file check instead of an unhandled 'error' crash */
    });
  } catch {
    return undefined;
  }
  return {
    async stop(): Promise<boolean> {
      try {
        // SIGINT the REMOTE screenrecord process so it finalizes the mp4 container cleanly —
        // killing the local adb client does not reliably stop or finalize the remote recording.
        await platform.run(
          platform.adbPath(),
          ['-s', serial, 'shell', 'pkill', '-SIGINT', 'screenrecord'],
          { timeoutMs: 5_000, env },
        );
        await sleep(1_500); // give screenrecord a moment to flush and finalize the file
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const pulled = await platform.run(
          platform.adbPath(),
          ['-s', serial, 'pull', remotePath, outputPath],
          { timeoutMs: 30_000, env },
        );
        await platform.run(platform.adbPath(), ['-s', serial, 'shell', 'rm', '-f', remotePath], {
          timeoutMs: 5_000,
          env,
        });
        child.kill();
        return pulled.code === 0 && fs.existsSync(outputPath);
      } catch {
        child.kill();
        return false;
      }
    },
  };
}
