import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { OsId, Platform, RunOptions, RunResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * macOS implementation of the platform seam — the only OS supported today.
 *
 * Android SDK resolution mirrors the standard macOS install location (`~/Library/Android/sdk`)
 * plus the usual env vars, so mobile testing works without the user exporting ANDROID_HOME/PATH.
 */
export class MacPlatform implements Platform {
  readonly os: OsId = 'macos';

  homedir(): string {
    return os.homedir();
  }

  which(cmd: string): string | undefined {
    try {
      const out = execFileSync('/usr/bin/which', [cmd], {
        encoding: 'utf8',
        timeout: 5_000,
      }).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
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
      return {
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? e.message ?? ''),
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  androidSdkRoot(): string | undefined {
    const candidates = [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      path.join(this.homedir(), 'Library', 'Android', 'sdk'),
    ].filter((c): c is string => Boolean(c));
    return candidates.find(dir => fs.existsSync(dir));
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
  throw new Error(
    `[pwtap] Only macOS is supported today — no Platform implementation for '${process.platform}'. ` +
      `Add one (e.g. a ${process.platform}.ts implementing Platform) and branch it in getPlatform().`,
  );
}

/** Test/advanced hook: override the cached platform (e.g. inject a fake in unit tests). */
export function setPlatform(platform: Platform | undefined): void {
  cached = platform;
}
