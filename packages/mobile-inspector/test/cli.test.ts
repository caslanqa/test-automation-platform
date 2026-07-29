/**
 * The `mobile-inspect` launch, driven as a real process — the only place the CLI, the window launcher and
 * the teardown meet.
 *
 * Found by packaging the product and running it: a signal arriving while Chromium was still launching left
 * `newPage()`/`goto()` to reject unhandled, so the CLI died with a stack trace and exit 1 before
 * `service.close()` could release the device lock or delete its temp files — the teardown ADR-011 requires.
 * Ctrl-C during startup is not an exotic case; it is what a user does when the window is slow to appear.
 *
 * Works with or without a browser installed: with none, the launcher falls back to printing the URL, and
 * every assertion here holds on both paths.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'inspect.mjs');
const LOCK = ['node_modules', '.cache', 'pwtap-inspector.lock.json'];

interface Launch {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** Start the CLI, wait for the URL it prints, signal it, and report how it went. */
async function launchAndSignal(projectRoot: string, signal: NodeJS.Signals): Promise<Launch> {
  const child = spawn(process.execPath, [BIN, projectRoot], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (buf: Buffer): void => {
    output += buf.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const exited = new Promise<Launch>(resolve =>
    child.on('exit', (exitCode, exitSignal) => resolve({ output, exitCode, signal: exitSignal })),
  );
  const printedUrl = new Promise<boolean>(resolve => {
    const check = (): void => {
      if (/http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(output)) {
        resolve(true);
      }
    };
    child.stdout.on('data', check);
    setTimeout(() => resolve(false), 20_000).unref();
  });

  await printedUrl;
  child.kill(signal);
  return await exited;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} during launch tears the inspector down cleanly`, async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-cli-'));
    try {
      const launch = await launchAndSignal(projectRoot, signal);

      assert.match(launch.output, /http:\/\/127\.0\.0\.1:\d+\/\?token=/, 'it must print a URL');
      assert.doesNotMatch(
        launch.output,
        /triggerUncaughtException|UnhandledPromiseRejection/,
        'the signal must not surface as a crash',
      );
      assert.equal(launch.exitCode, 0, `expected a clean exit; output:\n${launch.output}`);
      // The lock is what a crashed teardown leaves behind, and it refuses the next launch for this project.
      await assert.rejects(
        () => fs.stat(path.join(projectRoot, ...LOCK)),
        'the single-instance lock must be released',
      );
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
}
