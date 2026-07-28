/**
 * One inspector per project (architecture.md ADR-011).
 *
 * Electron gave us this for free via `requestSingleInstanceLock`; a plain service has to say it out loud.
 * Two recorders on one project would fight over the same device lock and produce two conflicting drafts of
 * the same test, so a second launch finds the first and points the user at it instead of starting a rival.
 *
 * The lock is a small JSON file holding the live service's port, token and pid. A stale one — the process
 * is gone, which is what a crash leaves behind — is reclaimed rather than treated as a conflict, because
 * refusing to start after a crash is worse than the race it would prevent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface LockInfo {
  port: number;
  token: string;
  pid: number;
}

function lockPath(projectRoot: string): string {
  return path.join(projectRoot, 'node_modules', '.cache', 'pwtap-inspector.lock.json');
}

/** True if a process with this pid is alive. Signal 0 checks liveness without touching the process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — alive for our purposes.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live inspector for this project, or `undefined` when there is none (including a stale lock). */
export async function readLock(projectRoot: string): Promise<LockInfo | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(lockPath(projectRoot), 'utf8')) as Partial<LockInfo>;
    if (
      typeof raw.port !== 'number' ||
      typeof raw.token !== 'string' ||
      typeof raw.pid !== 'number'
    ) {
      return undefined;
    }
    return isAlive(raw.pid) ? (raw as LockInfo) : undefined;
  } catch {
    return undefined; // absent or unreadable — no live instance
  }
}

export async function writeLock(projectRoot: string, info: LockInfo): Promise<void> {
  const file = lockPath(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

/** Best-effort: a lock we cannot delete is reclaimable anyway once our pid is gone. */
export async function releaseLock(projectRoot: string): Promise<void> {
  await fs.rm(lockPath(projectRoot), { force: true }).catch(() => undefined);
}
