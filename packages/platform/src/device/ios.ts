import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getPlatform } from '../platform.js';
import type { ScreenRecording } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface SimDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
}

/** All simulators from `xcrun simctl list devices -j`, flattened across runtimes. */
async function listSimulators(): Promise<SimDevice[]> {
  const { stdout, code } = await getPlatform().simctl(['list', 'devices', '-j'], {
    timeoutMs: 15_000,
  });
  if (code !== 0) {
    return [];
  }
  try {
    const data = JSON.parse(stdout) as { devices?: Record<string, SimDevice[]> };
    return Object.values(data.devices ?? {}).flat();
  } catch {
    return [];
  }
}

/** Resolve an iOS simulator name OR UDID to its UDID (from `simctl list devices`). */
export async function resolveSimUdid(nameOrUdid: string): Promise<string | undefined> {
  const match = (await listSimulators()).find(
    d => d.isAvailable !== false && (d.udid === nameOrUdid || d.name === nameOrUdid),
  );
  return match?.udid;
}

/**
 * Boot an iOS simulator (by name or UDID) and wait until ready; returns the resolved UDID. Only the
 * runtime is booted (no window) — visibility is separate (`openSimulatorApp`/`quitSimulatorApp`).
 */
export async function bootIosSim(nameOrUdid: string, timeoutMs = 120_000): Promise<string> {
  const udid = await resolveSimUdid(nameOrUdid);
  if (!udid) {
    throw new Error(
      `[pwtap] iOS simulator '${nameOrUdid}' not found — check 'xcrun simctl list devices'`,
    );
  }
  const platform = getPlatform();
  // Boot; simctl returns non-zero when already booted, which `run` reports (not throws) — ignore it.
  await platform.simctl(['boot', udid], { timeoutMs: 30_000 });
  // Block until the simulator has fully booted.
  await platform.simctl(['bootstatus', udid, '-b'], { timeoutMs });
  return udid;
}

/** Shut down a booted simulator by UDID (used by teardown). */
export async function shutdownSim(udid: string): Promise<void> {
  await getPlatform().simctl(['shutdown', udid], { timeoutMs: 30_000 });
}

/** Show the Simulator app (makes booted sims headed). Convenience wrapper over the platform seam. */
export async function openSimulatorApp(): Promise<void> {
  await getPlatform().openSimulatorApp();
}

/** Quit the Simulator app (makes iOS headless). Convenience wrapper over the platform seam. */
export async function quitSimulatorApp(): Promise<void> {
  await getPlatform().quitSimulatorApp();
}

// Re-exported so callers can `await sleep(...)` if they compose these; kept internal otherwise.
export { sleep as _sleep };

/** Zero-pad `n` to `len` digits. */
function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/**
 * The current moment (or `at`), formatted for `log show --start`/`--end`: LOCAL wall-clock time
 * with an EXPLICIT numeric UTC offset (`YYYY-MM-DD HH:MM:SS±HHMM`). `log show` interprets a bare
 * "HH:MM:SS" (no offset) as local time, so a naive UTC-formatted string silently captures the wrong
 * window — the explicit offset makes this correct regardless of the host's timezone. Call once
 * before a capture window begins.
 */
export function logCaptureStart(at: Date = new Date()): string {
  const offsetMin = -at.getTimezoneOffset(); // Date.getTimezoneOffset() is inverted (minutes BEHIND UTC)
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${offset}`
  );
}

/** Dump the simulator's unified system log since `start` (from {@link logCaptureStart}). */
export async function dumpSimLog(udid: string, start: string): Promise<string> {
  const { stdout } = await getPlatform().simctl(
    ['spawn', udid, 'log', 'show', '--start', start, '--style', 'compact'],
    { timeoutMs: 30_000 },
  );
  return stdout;
}

/**
 * Start recording the simulator's screen via `simctl io recordVideo`, writing directly to
 * `outputPath` (no device-side pull needed, unlike Android). Returns `undefined` on any spawn
 * failure (best-effort, never throws).
 */
export function startSimRecording(udid: string, outputPath: string): ScreenRecording | undefined {
  let child: ReturnType<typeof spawn>;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    child = spawn(
      'xcrun',
      ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', outputPath],
      { stdio: 'ignore' },
    );
    child.on('error', () => {
      /* surfaced via stop()'s file-existence check instead of an unhandled 'error' crash */
    });
  } catch {
    return undefined;
  }
  return {
    async stop(): Promise<boolean> {
      if (child.exitCode !== null) {
        return fs.existsSync(outputPath); // already exited (e.g. spawn failed) — report what's there
      }
      // simctl finalizes the video cleanly on SIGINT to this LOCAL process — unlike Android's
      // adb-shell case, there's no remote session that needs a separately signalled kill.
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGINT');
      await Promise.race([exited, sleep(5_000)]);
      return fs.existsSync(outputPath);
    },
  };
}
