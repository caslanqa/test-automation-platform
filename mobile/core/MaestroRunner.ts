import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { androidEnv } from './android';
import type { MaestroRunOptions, MaestroRunResult } from './types';

let parallelSupport: boolean | undefined;

/**
 * Whether this Maestro CLI can run concurrent flows on one host. Older Maestro (e.g. 2.0.0) pins its
 * on-device driver to a fixed port (7001), so two flows collide and hang; the rebuilt driver (Maestro
 * ≳ 2.6) allocates a port per process, so concurrent runs on different devices Just Work — verified on
 * 2.6.1 for both Android and iOS. Gate: `MOBILE_PARALLEL=1/0` overrides; otherwise Maestro >= 2.6.
 * When false, the fixture serializes all runs so `--workers>1` stays safe (no speedup). Detected once.
 */
export function maestroSupportsParallel(
  binary: string = process.env.MAESTRO_BIN ?? 'maestro'
): boolean {
  if (parallelSupport === undefined) {
    const override = process.env.MOBILE_PARALLEL?.trim();
    if (override) {
      parallelSupport = /^(1|true|yes|on)$/i.test(override);
    } else {
      try {
        const out = execFileSync(binary, ['--version'], {
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
        const [, major, minor] = m ? m.map(Number) : [];
        parallelSupport = m ? major > 2 || (major === 2 && minor >= 6) : false;
      } catch {
        parallelSupport = false;
      }
    }
  }
  return parallelSupport;
}

/**
 * Resolve a bare command name to its absolute path via `env.PATH`. Needed because we spawn Maestro
 * with `cwd` set, and Node fails to PATH-resolve a bare command name once `cwd` is specified. Returns
 * the input unchanged if it's already a path or can't be found (spawn then surfaces ENOENT).
 */
function resolveOnPath(binary: string, env: NodeJS.ProcessEnv): string {
  if (binary.includes(path.sep) || path.isAbsolute(binary)) {
    return binary;
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      if (dir && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return binary;
}

/**
 * Layer 1 — the mobile execution adapter. A thin wrapper around the Maestro CLI (`maestro test`),
 * invoked via `child_process.spawn`. Playwright orchestrates; Maestro drives the native device.
 * `run()` returns the result (exit code + captured output + artifact locations) WITHOUT throwing on
 * a failed flow — the fixture attaches artifacts first, then decides pass/fail. Only a missing
 * `maestro` binary rejects.
 *
 * @example
 * const res = await new MaestroRunner().run('tests/mobile/flows/android/settings.yaml', {
 *   device: 'emulator-5554',
 *   outputDir: testInfo.outputDir,
 * });
 */
export class MaestroRunner {
  private readonly binary: string;

  /** @param binary Maestro executable; defaults to `MAESTRO_BIN` env or `maestro` on PATH. */
  constructor(binary: string = process.env.MAESTRO_BIN ?? 'maestro') {
    this.binary = binary;
  }

  /**
   * Run one Maestro flow against a device. Spawns:
   * `maestro --device <id> test <abs-flow> --format=JUNIT --output <dir>/report.xml
   *  --test-output-dir <dir> --debug-output <dir>/debug --flatten-debug-output [--include-tags a,b]`
   */
  async run(flowPath: string, options: MaestroRunOptions): Promise<MaestroRunResult> {
    const absFlow = path.resolve(process.cwd(), flowPath);
    const junitPath = path.join(options.outputDir, 'report.xml');

    // We spawn Maestro with cwd set to the output dir (so a flow's `takeScreenshot: <name>` lands
    // there, not in the project root). Playwright creates that dir lazily, and spawn ENOENTs on a
    // missing cwd — so ensure it exists first.
    fs.mkdirSync(options.outputDir, { recursive: true });

    // `--device` is a GLOBAL option, before the `test` subcommand. `--format` value is uppercase.
    // Concurrent runs are safe on modern Maestro (it allocates a driver port per process); the fixture
    // has already serialized runs when the CLI is too old (see maestroSupportsParallel).
    const args = [
      '--device',
      options.device,
      'test',
      absFlow,
      '--format=JUNIT',
      '--output',
      junitPath,
      '--test-output-dir',
      options.outputDir,
      '--debug-output',
      path.join(options.outputDir, 'debug'),
      '--flatten-debug-output',
    ];
    if (options.tags && options.tags.length > 0) {
      args.push('--include-tags', options.tags.join(','));
    }

    // On Android, inject the SDK env so Maestro can locate adb even without a user-exported PATH.
    const env = options.platform === 'android' ? androidEnv() : process.env;

    return new Promise<MaestroRunResult>((resolve, reject) => {
      // Run from the test's output dir so a flow's `takeScreenshot: <name>` (a relative path) lands
      // there — attached to the report — instead of littering the project root. All the paths passed
      // above (flow, --output, --test-output-dir, --debug-output) are absolute, so cwd doesn't affect
      // them; the binary is pre-resolved because a `cwd` breaks Node's PATH lookup of a bare name.
      const child = spawn(resolveOnPath(this.binary, env), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        cwd: options.outputDir,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk.toString()));
      child.stderr.on('data', chunk => (stderr += chunk.toString()));

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `[maestro] '${this.binary}' not found on PATH — install Maestro (https://maestro.mobile.dev) or set MAESTRO_BIN`
            )
          );
        } else {
          reject(err);
        }
      });

      child.on('close', exitCode => {
        resolve({
          exitCode: exitCode ?? 1,
          outputDir: options.outputDir,
          junitPath,
          stdout,
          stderr,
        });
      });
    });
  }
}
