/**
 * The stdout contract, tested against the real built CLI.
 *
 * Claude Code accepts a marketplace `command` source only if it prints **exactly one line** — an
 * absolute path to a complete plugin — and exits 0. `packages/create/src/util/log.ts` routes
 * `info`/`step`/`done` to `console.info`, which is stdout, so a single stray `log.info` on the render
 * path breaks this for every user, silently. That is what this file exists to catch.
 *
 * It needs `dist/`, which CI has: the order is build → lint → typechecks → `npm test`.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A directory that looks enough like a pwtap project for `detect` to accept it. */
function pwtapProject(): string {
  const dir = tmp('pwtap-stdout-proj-');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'client',
      scripts: { test: 'playwright test', 'report:playwright': 'playwright show-report' },
      devDependencies: { '@playwright/test': '^1.61.0' },
      pwtap: { testsDir: 'tests' },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ reporter: [['list']] });\n",
  );
  return dir;
}

async function renderPath(project?: string): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    PWTAP_HOME: tmp('pwtap-stdout-home-'),
    PWTAP_AGENTS_OUT: tmp('pwtap-stdout-out-'),
    PWTAP_PROJECT: '',
    CLAUDE_PROJECT_DIR: '',
  };
  const args = ['claude-plugin-path', ...(project === undefined ? [] : ['--project', project])];
  return run(process.execPath, [CLI, ...args], { env });
}

test('stdout is exactly one absolute path to a directory that exists', async () => {
  const { stdout } = await renderPath(pwtapProject());

  assert.equal(stdout.endsWith('\n'), true, 'the line must be newline-terminated');
  const lines = stdout.split('\n');
  assert.equal(lines.length, 2, `expected one line plus the terminator, got ${lines.length - 1}`);
  const printed = lines[0];
  assert.ok(path.isAbsolute(printed), `not absolute: ${printed}`);
  assert.ok(fs.existsSync(printed), `does not exist: ${printed}`);
  assert.ok(fs.statSync(printed).isDirectory());
});

test('the printed directory holds plugin content at its top level', async () => {
  const { stdout } = await renderPath(pwtapProject());
  const printed = stdout.trimEnd();
  // Claude Code refuses a directory with no plugin content at the top level.
  assert.ok(fs.existsSync(path.join(printed, '.claude-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(printed, 'skills')));
  assert.ok(fs.readdirSync(path.join(printed, 'skills')).length > 0);
});

test('a project that is not a pwtap project still prints one line and exits 0', async () => {
  const { stdout, stderr } = await renderPath(tmp('pwtap-stdout-foreign-'));
  assert.equal(stdout.split('\n').length, 2);
  assert.ok(fs.existsSync(stdout.trimEnd()));
  assert.match(stderr, /is not a pwtap project/);
});

test('with no project resolvable at all, the baseline render still prints one line', async () => {
  const { stdout } = await renderPath();
  assert.equal(stdout.split('\n').length, 2);
  const printed = stdout.trimEnd();
  assert.equal(path.basename(printed), 'none');
  assert.match(fs.readFileSync(path.join(printed, 'README.md'), 'utf8'), /No pwtap project/);
});

test('warnings go to stderr, never to stdout', async () => {
  const project = pwtapProject();
  // A declared-but-unresolvable plugin is the warning path that runs on a real half-installed project.
  const pkg = path.join(project, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(pkg, 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  manifest.devDependencies['@pwtap/plugin-perf'] = '^0.1.0';
  fs.writeFileSync(pkg, JSON.stringify(manifest));

  const { stdout, stderr } = await renderPath(project);
  assert.equal(stdout.split('\n').length, 2, 'a warning must not add a stdout line');
  assert.match(stderr, /@pwtap\/plugin-perf/);
});

test('the verb is a verb, not a directory name', async () => {
  // Before the dispatch fix, `claude-plugin-path` fell through to `create` and would have scaffolded
  // into ./claude-plugin-path. The proof it is a verb: nothing named that is created next to the CLI.
  const { stdout } = await renderPath(pwtapProject());
  assert.equal(fs.existsSync(path.join(process.cwd(), 'claude-plugin-path')), false);
  assert.ok(stdout.trimEnd().length > 0);
});

test('rendering twice prints the same path and the same bytes', async () => {
  const project = pwtapProject();
  const home = tmp('pwtap-stdout-home-');
  const out = tmp('pwtap-stdout-out-');
  const env = {
    ...process.env,
    PWTAP_HOME: home,
    PWTAP_AGENTS_OUT: out,
    PWTAP_PROJECT: '',
    CLAUDE_PROJECT_DIR: '',
  };
  const args = [CLI, 'claude-plugin-path', '--project', project];

  const first = await run(process.execPath, args, { env });
  const digestOf = (dir: string): string =>
    fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .sort()
      .filter(rel => fs.statSync(path.join(dir, rel)).isFile())
      .map(rel => `${rel}:${fs.readFileSync(path.join(dir, rel), 'utf8')}`)
      .join('\0');

  const before = digestOf(first.stdout.trimEnd());
  const second = await run(process.execPath, args, { env });
  assert.equal(second.stdout, first.stdout, 'the path must be stable for a given project');
  assert.equal(digestOf(second.stdout.trimEnd()), before, 'a re-render must be byte-identical');
});
