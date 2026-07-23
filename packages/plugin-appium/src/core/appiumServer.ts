import { spawn } from 'node:child_process';

import { getPlatform, type MobilePlatform } from '@pwtap/platform';

export interface AppiumServerHandle {
  /** Base URL, e.g. `http://127.0.0.1:4723` — feed as `hostname`/`port`/`path` to `remote()`. */
  baseUrl: string;
  /** Stop the server THIS process spawned. No-op when connected to an externally-managed one. */
  stop(): Promise<void>;
}

const DEFAULT_PORT = 4723;
const READY_TIMEOUT_MS = 60_000;

/** Guard XCUITest (iOS) against non-macOS hosts — Android/UiAutomator2 has no such restriction. */
export function assertPlatformSupported(devicePlatform: MobilePlatform): void {
  if (devicePlatform === 'ios' && process.platform !== 'darwin') {
    throw new Error(
      '[appium] iOS (XCUITest) requires macOS — Xcode + the iOS simulator are macOS-only. Android ' +
        '(UiAutomator2) has no such restriction.',
    );
  }
}

async function waitUntilReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/status`);
      if (res.ok) {
        // The response wraps the payload in a `value` envelope (W3C convention), e.g.
        // `{ value: { ready: true, message, build } }` — not `{ ready: true }` at the top level.
        const body = (await res.json()) as { value?: { ready?: boolean } };
        if (body.value?.ready) {
          return;
        }
      }
    } catch {
      /* server not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`[appium] server didn't report ready within ${timeoutMs}ms at ${baseUrl}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

let cached: Promise<AppiumServerHandle> | undefined;

/**
 * Ensure a running Appium server for this worker process, spawning it once and reusing it across
 * every test the worker runs. `APPIUM_SERVER_URL` connects to an externally-managed server instead
 * (its lifecycle is the caller's responsibility — `stop()` is then a no-op). Otherwise spawns the
 * `appium` CLI (`APPIUM_BIN` env, default `appium` on PATH) on `4723 + workerIndex`, so parallel
 * workers each get their own server, and polls `GET /status` until `ready: true`. A spawned server
 * is best-effort killed on the worker process's `exit` — Node doesn't do this automatically for a
 * non-detached child.
 */
export function ensureAppiumServer(workerIndex: number): Promise<AppiumServerHandle> {
  if (cached) {
    return cached;
  }
  cached = (async () => {
    const external = process.env.APPIUM_SERVER_URL?.trim();
    if (external) {
      const baseUrl = external.replace(/\/+$/, '');
      await waitUntilReady(baseUrl, READY_TIMEOUT_MS);
      return { baseUrl, stop: async () => {} };
    }

    const bin = process.env.APPIUM_BIN || 'appium';
    if (!getPlatform().which(bin)) {
      throw new Error(
        `[appium] Appium CLI not found ('${bin}' not on PATH) — install it: npm install -g appium ` +
          '(see https://appium.io), then a driver: appium driver install uiautomator2 / xcuitest.',
      );
    }
    const port = DEFAULT_PORT + workerIndex;
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(bin, ['--port', String(port), '--base-path', '/'], { stdio: 'ignore' });
    child.on('error', () => {
      /* surfaced via the readiness timeout below */
    });
    process.on('exit', () => child.kill());
    await waitUntilReady(baseUrl, READY_TIMEOUT_MS);
    return {
      baseUrl,
      stop: async () => {
        child.kill();
      },
    };
  })();
  return cached;
}
