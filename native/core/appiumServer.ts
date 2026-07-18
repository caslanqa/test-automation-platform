import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_URL = 'http://127.0.0.1:4723';

// A server we spawned ourselves and reuse across this worker's tests (Playwright workers are separate
// processes, so a module-level handle is per-worker). Killed on process exit so it never lingers.
let spawned: ChildProcess | undefined;

/** Only ever auto-start a server for a local target — a remote URL is the user's to run. */
function isLocal(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/** Whether an Appium server answers `GET /status` at `baseUrl` within `timeoutMs`. */
async function isReachable(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/status`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the project-local `appium` bin (installed as a devDependency), or `undefined`. */
function appiumBin(): string | undefined {
  const bin = process.platform === 'win32' ? 'appium.cmd' : 'appium';
  const local = path.join(process.cwd(), 'node_modules', '.bin', bin);
  return fs.existsSync(local) ? local : undefined;
}

function killSpawned(): void {
  if (spawned && !spawned.killed) {
    try {
      spawned.kill();
    } catch {
      // best-effort; the process may already be gone
    }
  }
  spawned = undefined;
}

/**
 * Ensure an Appium server is reachable and return its base URL, or `null` when none is available and
 * we can't start one (the fixture then SKIPS the test — mirrors mobile's "no device → skip"). Order:
 * 1. if the target URL already answers `GET /status`, use it (a server you started yourself);
 * 2. otherwise, for a LOCAL target, best-effort spawn the project's `appium` bin once and reuse it
 *    across the worker's tests (killed on process exit);
 * 3. if `appium` isn't installed, or a remote target is down, return `null`.
 */
export async function ensureAppiumServer(url?: string): Promise<string | null> {
  const baseUrl = (url || process.env.NATIVE_SERVER_URL || DEFAULT_URL).replace(/\/+$/, '');
  if (await isReachable(baseUrl)) {
    return baseUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!isLocal(parsed.hostname)) {
    return null;
  }
  // Reuse a server we already spawned in this worker (a previous test's start).
  if (spawned && (await isReachable(baseUrl))) {
    return baseUrl;
  }
  const bin = appiumBin();
  if (!bin) {
    return null;
  }

  const port = parsed.port || '4723';
  spawned = spawn(bin, ['--address', '127.0.0.1', '--port', String(port), '--log-level', 'error'], {
    stdio: 'ignore',
  });
  // Never leak the server past this process.
  process.once('exit', killSpawned);
  process.once('SIGINT', killSpawned);
  process.once('SIGTERM', killSpawned);

  // Poll until it answers (a cold start is a couple of seconds), giving up after ~30s.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isReachable(baseUrl)) {
      return baseUrl;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  killSpawned();
  return null;
}
