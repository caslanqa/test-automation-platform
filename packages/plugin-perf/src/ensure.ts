/**
 * Advisory checks after `create-pwtap add perf` — hints, never failures.
 *
 * Two things can genuinely be missing, and both surface at the worst possible moment otherwise: `autocannon` as a
 * module error inside the first `bench.run`, and the k6 binary as a shell "command not found" from an npm script.
 *
 * **Nothing here installs anything.** `ensure` runs as part of `create-pwtap add`, and a scaffold step that
 * mutates the machine — a system package manager, `sudo` on Linux — is not a side effect anybody asked for. What it
 * does instead is work out the command that is actually right for THIS machine, which a hardcoded
 * `brew install k6` is not: it is wrong on every Linux CI runner, and wrong on a Mac without Homebrew.
 *
 * There is no npm route to offer. k6 runs its own JavaScript runtime rather than Node, and the `k6` package on npm
 * is a stub for editor autocomplete, not the binary — so `npm i -D k6` cannot work the way `npm i -D playwright`
 * does.
 *
 * Layer 2's one env key, `PERF_TARGET_URL`, is deliberately NOT warned about: it is empty in a fresh scaffold by
 * design, and every k6 scenario already aborts at init with the full instruction. Warning at install time about the
 * expected state is how `ensure` output gets ignored.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** k6's own documented install routes, in the order to prefer them, per platform. */
const INSTALL_ROUTES: Record<string, Array<{ binary: string; command: string }>> = {
  darwin: [{ binary: 'brew', command: 'brew install k6' }],
  linux: [
    {
      binary: 'apt-get',
      command: [
        'curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg',
        'echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list',
        'sudo apt-get update && sudo apt-get install k6',
      ].join('\n      '),
    },
    {
      binary: 'dnf',
      command: 'sudo dnf install https://dl.k6.io/rpm/repo.rpm && sudo dnf install k6',
    },
    {
      binary: 'yum',
      command: 'sudo yum install https://dl.k6.io/rpm/repo.rpm && sudo yum install k6',
    },
  ],
  win32: [
    { binary: 'winget', command: 'winget install k6 --source winget' },
    { binary: 'choco', command: 'choco install k6' },
  ],
};

const DOCS_URL = 'https://grafana.com/docs/k6/latest/set-up/install-k6/';
/** Works wherever Docker does, needs no package manager, and installs nothing on the host. */
const DOCKER_ROUTE =
  'docker run --rm -i -v "$PWD:/src" -w /src grafana/k6 run perf/smoke.ts ' +
  '(add --network host, or target host.docker.internal, to reach a service on this machine)';

/**
 * The install instruction that fits this machine.
 *
 * Pure: `isOnPath` is injected, so every branch is unit tested without a package manager present. Returns the
 * body of the warning, without the "k6 is missing" preamble.
 *
 * @example k6InstallHint('linux', bin => bin === 'dnf'); // → 'sudo dnf install https://dl.k6.io/rpm/repo.rpm …'
 */
export function k6InstallHint(platform: string, isOnPath: (binary: string) => boolean): string {
  const routes = INSTALL_ROUTES[platform] ?? [];
  const usable = routes.find(route => isOnPath(route.binary));
  if (usable) {
    return `install it with:\n      ${usable.command}\n    Other routes: ${DOCS_URL}`;
  }

  // Naming what was looked for matters: "install k6" is not actionable on a machine whose package manager the
  // reader has not thought about in a year.
  const looked = routes.map(route => route.binary).join(', ');
  const preamble = routes.length
    ? `no supported package manager found on PATH (looked for ${looked})`
    : `no package-manager route is known for platform "${platform}"`;
  return (
    `${preamble}. Download a standalone binary from https://github.com/grafana/k6/releases ` +
    `and put it on PATH, or skip installing entirely and run k6 in Docker:\n      ${DOCKER_ROUTE}\n` +
    `    All routes: ${DOCS_URL}`
  );
}

/**
 * Is `binary` on PATH?
 *
 * Reads PATH directly rather than shelling out to `which`/`where`: no subprocess, no shell quoting, and it behaves
 * the same on Windows, where an executable is found by appending a `PATHEXT` extension.
 */
export function isOnPath(binary: string): boolean {
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  return directories.some(directory =>
    extensions.some(extension => fs.existsSync(path.join(directory, binary + extension))),
  );
}

export async function ensure(): Promise<void> {
  const warn = (message: string): void => console.warn(`⚠ [perf] ${message}`);

  const require = createRequire(`${process.cwd()}/`);
  try {
    require.resolve('autocannon');
  } catch {
    warn(
      'autocannon is not resolvable from this project, so the `bench` fixture cannot run — ' +
        'reinstall dependencies (npm install), or npm i -D autocannon',
    );
  }

  // Actually run it rather than only looking for it on PATH: a binary of the wrong architecture, or one whose
  // install left a broken shim, is on PATH and still cannot run a scenario.
  try {
    await run('k6', ['version']);
  } catch {
    warn(
      'the k6 binary is not runnable, so the load scripts in perf/ cannot run — ' +
        `${k6InstallHint(process.platform, isOnPath)}\n` +
        '    The Layer 1 fixtures (vitals, budget, bench) do not need it.',
    );
  }
}
