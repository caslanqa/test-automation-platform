/**
 * Runs a recorded test back through the project's own Playwright. Owns only the child process and its temp
 * file — it never touches the draft or the device (§6).
 *
 * @example await new TestRunner(projectRoot, emit).run(source, driver.testBinding);
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { DriverTestBinding } from '@pwtap/mobile-core';

import type { RecorderEvent } from './protocol.js';

/** Where temp run files live. Real, non-hidden, and swept — a crash must not leave a collectable test. */
const RUN_DIR = ['tests', '__inspector__'];

export class TestRunner {
  private child: ChildProcess | undefined;

  private readonly projectRoot: string;
  private readonly emit: (event: RecorderEvent) => void;

  constructor(projectRoot: string, emit: (event: RecorderEvent) => void) {
    this.projectRoot = projectRoot;
    this.emit = emit;
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  /**
   * Spawn `playwright test <file> --project=<driver>` with the driver's gate variable set. Both are
   * required: without `--project` the file is collected by the browser project, and without the gate the
   * driver's project does not exist in the resolved config at all (§8).
   */
  async run(source: string, binding: DriverTestBinding): Promise<void> {
    if (this.child) {
      this.emit({ type: 'error', message: 'a run is already in progress' });
      return;
    }
    let bin: string;
    try {
      bin = resolvePlaywrightBin(this.projectRoot);
    } catch (error) {
      this.emit({ type: 'error', message: errorMessage(error) });
      return;
    }

    const runDir = path.resolve(this.projectRoot, ...RUN_DIR);
    await fs.mkdir(runDir, { recursive: true });
    await sweepStaleRuns(runDir);
    const file = path.join(runDir, `run-${Date.now()}${binding.extension}`);
    await fs.writeFile(file, source, 'utf8');

    const child = spawn(bin, ['test', file, `--project=${binding.project}`], {
      cwd: this.projectRoot,
      env: { ...process.env, [binding.gateEnv]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.emit({ type: 'runStatus', state: 'started' });

    child.stdout?.on('data', (buf: Buffer) =>
      this.emit({ type: 'runOutput', stream: 'stdout', chunk: buf.toString() }),
    );
    child.stderr?.on('data', (buf: Buffer) =>
      this.emit({ type: 'runOutput', stream: 'stderr', chunk: buf.toString() }),
    );
    child.on('error', error => {
      this.emit({ type: 'error', message: `failed to start test run: ${errorMessage(error)}` });
    });
    child.on('close', code => {
      this.child = undefined;
      void fs.rm(file, { force: true });
      this.emit({ type: 'runStatus', state: 'finished', exitCode: code });
    });
  }

  /** Kill exactly the child we spawned — never a name-based kill. */
  stop(): void {
    this.child?.kill('SIGTERM');
  }
}

/** Best-effort: a sweep failure must never block the run the user asked for. */
async function sweepStaleRuns(runDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(runDir);
    await Promise.all(
      entries
        .filter(name => name.startsWith('run-'))
        .map(name => fs.rm(path.join(runDir, name), { force: true })),
    );
  } catch {
    // Nothing to sweep, or unreadable.
  }
}

function resolvePlaywrightBin(projectRoot: string): string {
  const bin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
  );
  if (!fsSync.existsSync(bin)) {
    throw new Error(`Playwright CLI not found at ${bin} — run "npm install" in the project first`);
  }
  return bin;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
