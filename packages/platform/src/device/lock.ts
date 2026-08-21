import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cross-process device reservation lock (atomic mkdir), so parallel Playwright workers run at most one
// test per device at a time. Same key → serialized (workers WAIT, not skip); different keys → parallel.
// OS-agnostic — shared by every mobile plugin (Maestro, Appium) via @pwtap/platform.
//
// The key is `<platform>:<device>`, one lock per device — two tests on the same device serialize while
// distinct devices (and platforms) run in parallel.

const POLL_MS = 300;
const MAX_WAIT_MS = 30 * 60 * 1000; // many tests can queue on one device over a run
const STALE_MS = 10 * 60 * 1000; // steal a lock left by a crashed worker (a single hold is one test)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function lockDir(key: string): string {
  return path.join(os.tmpdir(), `pw-ai-devlock-${key.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
}

export interface DeviceLockOptions {
  /**
   * How long to wait before giving up, in milliseconds. Defaults to `MAX_WAIT_MS`.
   *
   * Thirty minutes is right for a Playwright worker: many tests queue on one device over a run, and a
   * worker that gave up would fail a test for a scheduling fact. It is wrong for anything a human is
   * waiting on — an interactive tool blocked for half an hour with no output reads as a hang, and there
   * is no way to tell it apart from one.
   *
   * The guard lives here rather than in the caller deliberately: racing an unbounded acquire and
   * abandoning it leaks the lock when the abandoned attempt later succeeds.
   */
  timeoutMs?: number;
}

/**
 * Acquire the device lock for `key`, waiting until it's free (stealing one left by a crashed worker
 * after `STALE_MS`). Returns a release function to call when the device is no longer needed.
 */
export async function acquireDeviceLock(
  key: string,
  options: DeviceLockOptions = {},
): Promise<() => void> {
  const dir = lockDir(key);
  const maxWait = options.timeoutMs ?? MAX_WAIT_MS;
  let waited = 0;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) {
          fs.rmdirSync(dir);
          continue; // stale (crashed holder) → steal and retry
        }
      } catch {
        continue; // lock vanished between mkdir and stat → retry immediately
      }
      if (waited >= maxWait) {
        throw new Error(
          `[pwtap] timed out waiting for device lock '${key}' after ${Math.round(maxWait / 1000)}s — another pwtap process (a test run, the inspector, or an MCP session) is using that device`,
        );
      }
      await sleep(POLL_MS);
      waited += POLL_MS;
    }
  }
  return () => {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* already released */
    }
  };
}

/** The per-device lock key (`<platform>:<device>`); same device serializes, distinct devices parallel. */
export function deviceLockKey(platform: 'android' | 'ios', deviceName?: string): string {
  return `${platform}:${deviceName ?? 'any'}`;
}
