import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { OsId, Platform, RunOptions, RunResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * What macOS and Linux share: process execution, PATH lookup, and Android SDK/tool resolution. Only the SDK
 * search path and the iOS half differ, so a host implementation states those and inherits the rest.
 */
abstract class PosixPlatform implements Platform {
  abstract readonly os: OsId;

  /** Directories to look for an Android SDK in, most authoritative first. */
  protected abstract androidSdkCandidates(): Array<string | undefined>;

  abstract simctl(args: string[], opts?: RunOptions): Promise<RunResult>;
  abstract openSimulatorApp(): Promise<void>;
  abstract quitSimulatorApp(): Promise<void>;

  homedir(): string {
    return os.homedir();
  }

  which(cmd: string): string | undefined {
    for (const lookup of ['/usr/bin/which', 'which']) {
      try {
        const out = execFileSync(lookup, [cmd], { encoding: 'utf8', timeout: 5_000 }).trim();
        return out || undefined;
      } catch (err) {
        // Only a missing `which` itself is worth retrying: a distro without /usr/bin/which would otherwise
        // report every tool as absent, which reads as "adb is not installed" rather than as a host problem.
        if ((err as { code?: string }).code !== 'ENOENT') {
          return undefined;
        }
      }
    }

    return undefined;
  }

  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    try {
      const res = await execFileAsync(cmd, args, {
        timeout: opts.timeoutMs ?? 15_000,
        env: opts.env,
        cwd: opts.cwd,
        encoding: 'utf8',
      });
      return { stdout: res.stdout.toString(), stderr: res.stderr.toString(), code: 0 };
    } catch (err) {
      const e = err as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: number | string;
        message?: string;
      };
      // `??` is not enough here: a binary that never spawned rejects with stderr set to the EMPTY string, so
      // only `||` keeps the reason ("spawn … ENOENT") instead of reporting a failure with no explanation.
      const stderr = String(e.stderr ?? '');
      return {
        stdout: String(e.stdout ?? ''),
        stderr: stderr || String(e.message ?? ''),
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  androidSdkRoot(): string | undefined {
    return this.androidSdkCandidates()
      .filter((dir): dir is string => Boolean(dir))
      .find(dir => fs.existsSync(dir));
  }

  /** Resolve an SDK tool path (`platform-tools/adb`, `emulator/emulator`), or the bare name if unknown. */
  private sdkTool(subdir: string, name: string): string {
    const sdk = this.androidSdkRoot();
    if (sdk) {
      const exe = path.join(sdk, subdir, name);
      if (fs.existsSync(exe)) {
        return exe;
      }
    }
    return name;
  }

  adbPath(): string {
    return this.sdkTool('platform-tools', 'adb');
  }

  emulatorPath(): string {
    return this.sdkTool('emulator', 'emulator');
  }

  androidEnv(): NodeJS.ProcessEnv {
    const sdk = this.androidSdkRoot();
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
}

/**
 * macOS implementation of the platform seam — the only host that can drive iOS.
 *
 * Android SDK resolution mirrors the standard macOS install location (`~/Library/Android/sdk`) plus the usual
 * env vars, so mobile testing works without the user exporting ANDROID_HOME/PATH.
 */
export class MacPlatform extends PosixPlatform {
  readonly os: OsId = 'macos';

  protected androidSdkCandidates(): Array<string | undefined> {
    return [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      path.join(this.homedir(), 'Library', 'Android', 'sdk'),
    ];
  }

  async simctl(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return this.run('xcrun', ['simctl', ...args], { timeoutMs: 15_000, ...opts });
  }

  async openSimulatorApp(): Promise<void> {
    // Idempotent: the Simulator app shows whatever sims are booted; safe to call for a reused sim.
    await this.run('open', ['-a', 'Simulator'], { timeoutMs: 15_000 });
  }

  async quitSimulatorApp(): Promise<void> {
    // Booted sims stay `Booted` (the runtime is independent of the app), so no reboot needed.
    await this.run('osascript', ['-e', 'tell application "Simulator" to quit'], {
      timeoutMs: 10_000,
    });
  }
}

/**
 * Linux implementation — Android only, which is the whole point of it: Linux hosts (CI runners with KVM,
 * developer workstations) can run the emulator, and iOS simulators do not exist off macOS.
 *
 * The iOS half reports failure instead of throwing, because that is what the callers already handle: device
 * discovery and the app/device pickers treat a non-zero `simctl` as "no simulators" and stay usable, where a
 * throw would take down a picker that was only ever asking.
 */
export class LinuxPlatform extends PosixPlatform {
  readonly os: OsId = 'linux';

  protected androidSdkCandidates(): Array<string | undefined> {
    return [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      path.join(this.homedir(), 'Android', 'Sdk'),
      // GitHub's ubuntu runners ship the SDK here and normally export ANDROID_HOME too; the literal path is
      // the fallback for a runner image that stops doing so.
      '/usr/local/lib/android/sdk',
    ];
  }

  /** Same signature as the macOS one on purpose: callers pass simctl arguments without checking the host. */
  async simctl(_args: string[], _opts?: RunOptions): Promise<RunResult> {
    return {
      stdout: '',
      stderr:
        '[pwtap] iOS simulators need macOS — this host is Linux, so no simulator is available.',
      code: 1,
    };
  }

  /** Nothing to open: there is no Simulator app on Linux, and callers treat this as best-effort. */
  async openSimulatorApp(): Promise<void> {
    return undefined;
  }

  async quitSimulatorApp(): Promise<void> {
    return undefined;
  }
}

let cached: Platform | undefined;

/** Return the Platform for the current OS. Throws (naming the file to add) on unsupported OSes. */
export function getPlatform(): Platform {
  if (cached) {
    return cached;
  }
  if (process.platform === 'darwin') {
    cached = new MacPlatform();
    return cached;
  }
  if (process.platform === 'linux') {
    cached = new LinuxPlatform();
    return cached;
  }

  throw new Error(
    `[pwtap] macOS and Linux are supported today — no Platform implementation for '${process.platform}'. ` +
      `Add one (e.g. a ${process.platform}.ts implementing Platform) and branch it in getPlatform().`,
  );
}

/** Test/advanced hook: override the cached platform (e.g. inject a fake in unit tests). */
export function setPlatform(platform: Platform | undefined): void {
  cached = platform;
}
