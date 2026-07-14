import fs from 'fs';
import os from 'os';
import path from 'path';

// Cross-process device reservation lock (atomic mkdir), so parallel Playwright workers run at most one
// test per device at a time. Same key → serialized (workers WAIT, not skip); different keys → parallel.
//
// The key is `<platform>:<device>`, one lock per device — so two tests on the same device serialize
// while distinct devices (and platforms) run in parallel. Modern Maestro (>= ~2.6) runs concurrent
// flows across devices safely; on older Maestro the fixture instead uses a single shared key to
// serialize everything (see maestroSupportsParallel).

const POLL_MS = 300;
const MAX_WAIT_MS = 30 * 60 * 1000; // many tests can queue on one device over a run
const STALE_MS = 10 * 60 * 1000; // steal a lock left by a crashed worker (a single hold is one test)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function lockDir(key: string): string {
  return path.join(os.tmpdir(), `pw-ai-devlock-${key.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
}

/**
 * Acquire the device lock for `key`, waiting until it's free (stealing one left by a crashed worker
 * after `STALE_MS`). Returns a release function to call when the device is no longer needed.
 */
export async function acquireDeviceLock(key: string): Promise<() => void> {
  const dir = lockDir(key);
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
      if (waited >= MAX_WAIT_MS) {
        throw new Error(`[mobile] timed out waiting for device lock '${key}'`);
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
