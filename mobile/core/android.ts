import { execFile, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Android SDK / adb / emulator resolution so mobile testing works without the user exporting
// ANDROID_HOME/PATH: device discovery (adb), Maestro (shells out to adb), and auto-boot (emulator)
// all need the SDK. We check the standard env vars first, then the per-OS default install location.

/** Best-effort Android SDK root: `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or the OS default. */
export function androidSdkRoot(): string | undefined {
  const home = os.homedir();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : undefined,
    process.platform === 'linux' ? path.join(home, 'Android', 'Sdk') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
  ].filter((c): c is string => Boolean(c));

  return candidates.find(dir => fs.existsSync(dir));
}

/** Resolve an SDK tool path (`platform-tools/adb`, `emulator/emulator`), or bare name if not found. */
function sdkTool(subdir: string, name: string): string {
  const sdk = androidSdkRoot();
  if (sdk) {
    const exe = path.join(sdk, subdir, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(exe)) {
      return exe;
    }
  }
  return name;
}

/** The `adb` executable — the resolved SDK's copy when present, else bare `adb` (PATH). */
export function adbPath(): string {
  return sdkTool('platform-tools', 'adb');
}

/**
 * Environment for spawning Maestro/emulator against Android: inject `ANDROID_HOME` + prepend
 * `platform-tools` to PATH when a SDK is found, so tools locate adb even if nothing was exported.
 */
export function androidEnv(): NodeJS.ProcessEnv {
  const sdk = androidSdkRoot();
  if (!sdk) {
    return process.env;
  }
  const platformTools = path.join(sdk, 'platform-tools');
  return {
    ...process.env,
    ANDROID_HOME: process.env.ANDROID_HOME ?? sdk,
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT ?? sdk,
    PATH: `${platformTools}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

/** List installed AVD names (`emulator -list-avds`), or `[]` if the emulator tool is unavailable. */
export function listAvds(): string[] {
  try {
    return execFileSync(sdkTool('emulator', 'emulator'), ['-list-avds'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The AVD name backing a booted emulator serial (`adb -s <serial> emu avd name`), or `undefined`. */
export async function avdNameForSerial(serial: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(adbPath(), ['-s', serial, 'emu', 'avd', 'name'], {
      timeout: 5_000,
    });
    // Output is the AVD name on the first line, then `OK`.
    return stdout.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// An emulator's window mode (`-no-window` or not) is fixed at boot and can't be changed on a running
// instance. We record the mode we booted each AVD in — in a temp file cleared on OS reboot — so a
// reused emulator can be restarted when a test asks for the other mode (see DeviceManager.acquire).

function modeMarker(avdName: string): string {
  return path.join(os.tmpdir(), `pw-ai-emu-${avdName.replace(/[^A-Za-z0-9_.-]/g, '_')}.mode`);
}

/** Record the mode an AVD was just booted in (best-effort). */
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
  const adb = adbPath();
  await execFileAsync(adb, ['-s', serial, 'emu', 'kill'], { timeout: 10_000 }).catch(
    () => undefined
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const out = await execFileAsync(adb, ['devices'], { timeout: 5_000 })
      .then(r => r.stdout)
      .catch(() => '');
    if (!out.split('\n').some(line => line.startsWith(serial))) {
      return;
    }
    await sleep(1_000);
  }
}

/**
 * Boot an Android AVD by name and wait until it's ready to run a flow. Launches the emulator detached
 * (so it outlives the test process — booted devices are reused, not shut down), then waits for the
 * device to be genuinely ready: `sys.boot_completed=1` AND the package manager able to resolve a
 * package. The `pm` gate matters because `boot_completed` fires seconds before `pm` can install APKs
 * — and Maestro installs a helper APK first, so booting on `boot_completed` alone makes the first run
 * flakily fail with an install error. Throws with an actionable message if the AVD/emulator is missing
 * or the boot times out.
 */
export async function bootAndroidAvd(
  avdName: string,
  headless = true,
  timeoutMs = 180_000
): Promise<void> {
  const emulator = sdkTool('emulator', 'emulator');
  if (!listAvds().includes(avdName)) {
    const avds = listAvds();
    throw new Error(
      `[mobile] AVD '${avdName}' not found${avds.length ? ` (have: ${avds.join(', ')})` : ' — is the Android SDK installed?'}`
    );
  }

  // The emulator shows a window by default; `-no-window` runs it headless.
  const child = spawn(emulator, ['-avd', avdName, ...(headless ? ['-no-window'] : [])], {
    detached: true,
    stdio: 'ignore',
    env: androidEnv(),
  });
  child.unref();
  recordEmulatorMode(avdName, headless);

  const adb = adbPath();
  const sh = (args: string[]): Promise<string> =>
    execFileAsync(adb, args, { timeout: 5_000 })
      .then(r => r.stdout)
      .catch(() => '');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bootCompleted = (await sh(['shell', 'getprop', 'sys.boot_completed'])).trim() === '1';
    const pmReady =
      bootCompleted && (await sh(['shell', 'pm', 'path', 'android'])).includes('package:');
    if (pmReady) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`[mobile] AVD '${avdName}' did not finish booting within ${timeoutMs / 1000}s`);
}
