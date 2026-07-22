import { spawn } from 'node:child_process';

/** Strip inherited `npm_*` lifecycle env so a nested `npm install` uses a clean config. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_')) {
      delete env[key];
    }
  }
  return env;
}

export interface RunOptions {
  cwd?: string;
  /** Silence child stdio (default false — inherit, so npm/playwright output is visible). */
  silent?: boolean;
}

/** Run a command to completion; rejects on non-zero exit or spawn error. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: cleanEnv(),
      stdio: opts.silent ? 'ignore' : 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolve()
        : reject(new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`)),
    );
  });
}
