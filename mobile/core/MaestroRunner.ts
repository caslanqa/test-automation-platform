import { spawn } from 'child_process';
import path from 'path';

import { androidEnv } from './android';
import type { MaestroRunOptions, MaestroRunResult } from './types';

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

    // `--device` is a GLOBAL option, before the `test` subcommand. `--format` value is uppercase.
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
      const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
