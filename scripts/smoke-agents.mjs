#!/usr/bin/env node
/**
 * End-to-end smoke test for the rendered Claude Code agent plugin: build → bundle → scaffold a
 * core-only project → render the plugin directory → assert the stdout contract, the layout, and —
 * the point of the whole exercise — that capability gating actually works in both directions.
 *
 * Run with `npm run smoke:agents`. Fails (non-zero) on any broken assertion.
 *
 * Why the mobile plugin is faked by hand rather than installed with `create-pwtap add appium`: in CI
 * that would install the *published* plugin, so the smoke would silently test a stale version and
 * gain a network dependency. Capability detection's only input is whether `<pkg>/manifest` resolves
 * from the client's node_modules, so a hand-written package fakes exactly the seam under test.
 *
 * @example
 *   npm run smoke:agents   # prints "[smoke] OK" when gating, the layout and idempotence all hold
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const CLI = path.join(root, 'packages/create/dist/index.js');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { stdio: 'inherit', cwd: cwd ?? root });

const fail = message => {
  throw new Error(`[smoke] ${message}`);
};
const assert = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-agents-home-'));
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-agents-out-'));

/**
 * Render the plugin and return its printed directory, asserting the stdout contract every time.
 *
 * stderr is captured rather than inherited so the assertions can read the renderer's own warnings —
 * which is the exact roster-drift check: a definition naming a script the project does not have.
 */
function render(project, { outRoot: outOverride, home: homeOverride } = {}) {
  const stderrFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-agents-err-')),
    'stderr.txt',
  );
  const stderrFd = fs.openSync(stderrFile, 'w');
  let stdout;
  try {
    stdout = execFileSync(
      'node',
      [CLI, 'claude-plugin-path', ...(project === null ? [] : ['--project', project])],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', stderrFd],
        env: {
          ...process.env,
          PWTAP_HOME: homeOverride ?? home,
          PWTAP_AGENTS_OUT: outOverride ?? outRoot,
          PWTAP_PROJECT: '',
          CLAUDE_PROJECT_DIR: '',
        },
      },
    );
  } finally {
    fs.closeSync(stderrFd);
  }
  const stderr = fs.readFileSync(stderrFile, 'utf8');

  const lines = stdout.split('\n');
  assert(
    lines.length === 2 && lines[1] === '',
    `stdout must be exactly one line, got: ${JSON.stringify(stdout)}`,
  );
  const printed = lines[0];
  assert(path.isAbsolute(printed), `printed path is not absolute: ${printed}`);
  assert(fs.existsSync(printed), `printed path does not exist: ${printed}`);
  assert(fs.statSync(printed).isDirectory(), `printed path is not a directory: ${printed}`);

  // Roster drift: a rendered definition must never tell the model to run a script this project does
  // not have. The renderer already detects it, so assert on that rather than grepping prose — a
  // driver comparison table legitimately names both drivers' scripts.
  const drift = stderr
    .split('\n')
    .filter(line => line.includes('references script'))
    .join('\n');
  assert(drift === '', `a rendered definition names a script this project lacks:\n${drift}`);

  return printed;
}

const has = (dir, ...parts) => fs.existsSync(path.join(dir, ...parts));

/** Sorted list of every file under `dir`, relative and POSIX-separated. */
function fileList(dir) {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(rel => fs.statSync(path.join(dir, rel)).isFile())
    .map(rel => rel.split(path.sep).join('/'))
    .sort();
}

console.log('[smoke] building packages…');
run('npx', ['tsc', '-b']);

console.log('[smoke] bundling core-template into @pwtap/create…');
run('npm', ['run', 'bundle:template', '-w', '@pwtap/create']);

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-agents-project-'));
console.log(`[smoke] scaffolding core-only project into ${project}…`);
// Install is left on: capability detection resolves through a real node_modules, and faking that
// would test the fake instead of the seam.
run('node', [CLI, project, '-y', '--no-browsers']);

console.log('[smoke] rendering the plugin for a core-only project…');
const first = render(project);

console.log('[smoke] asserting the baseline layout…');
for (const file of [
  '.claude-plugin/plugin.json',
  'README.md',
  'agents/vv-lead.md',
  'agents/run-triage.md',
  'skills/spec-conventions/SKILL.md',
  'skills/failure-triage/SKILL.md',
  'commands/vv.md',
  'commands/vv-status.md',
  'hooks/hooks.json',
  'hooks/check-markers.mjs',
]) {
  assert(has(first, file), `expected file missing from the render: ${file}`);
}

// plugin.json must not set the component path fields — they REPLACE the default scan, and the
// default scan is exactly what we emit.
const manifest = JSON.parse(
  fs.readFileSync(path.join(first, '.claude-plugin/plugin.json'), 'utf8'),
);
assert(manifest.name === 'pwtap', `plugin.json name should be 'pwtap', got ${manifest.name}`);
for (const field of ['agents', 'commands', 'skills', 'workflows', 'outputStyles']) {
  assert(manifest[field] === undefined, `plugin.json must not set '${field}'`);
}

console.log('[smoke] asserting gating — nothing mobile, db, perf or ai without those plugins…');
for (const absent of [
  'agents/mobile-vv.md',
  'agents/release-gate.md',
  'skills/mobile-locators/SKILL.md',
  'skills/db-state-verification/SKILL.md',
  'skills/perf-budgets/SKILL.md',
  'skills/ai-judge-rubrics/SKILL.md',
]) {
  assert(!has(first, absent), `gating failed: ${absent} was rendered without its capability`);
}
// An agent's `skills:` list must never name a component that is not in the plugin.
const strategist = fs.readFileSync(path.join(first, 'agents/test-strategist.md'), 'utf8');
for (const pruned of ['db-state-verification', 'perf-budgets']) {
  assert(
    !strategist.includes(`pwtap:${pruned}`),
    `test-strategist still names pwtap:${pruned}, which was gated out`,
  );
}

console.log('[smoke] faking a resolvable mobile plugin (no npm, no network)…');
const fake = path.join(project, 'node_modules', '@pwtap', 'plugin-appium');
fs.mkdirSync(fake, { recursive: true });
fs.writeFileSync(
  path.join(fake, 'package.json'),
  `${JSON.stringify(
    {
      name: '@pwtap/plugin-appium',
      version: '0.0.0-smoke',
      type: 'module',
      exports: { '.': './index.js', './manifest': './manifest.js' },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(path.join(fake, 'index.js'), 'export default {};\n');
fs.writeFileSync(
  path.join(fake, 'manifest.js'),
  "export const manifest = { id: 'appium', name: '@pwtap/plugin-appium', devDependencies: {}, scripts: {}, envKeys: {} };\n",
);

console.log('[smoke] re-rendering — the mobile pieces must appear, and only those…');
const second = render(project);
assert(second === first, 'the printed path must be stable for a given project');
assert(
  has(second, 'agents/mobile-vv.md'),
  'mobile-vv did not appear after installing a mobile plugin',
);
assert(has(second, 'skills/mobile-locators/SKILL.md'), 'mobile-locators did not appear');
for (const stillAbsent of [
  'skills/db-state-verification/SKILL.md',
  'skills/perf-budgets/SKILL.md',
  'skills/ai-judge-rubrics/SKILL.md',
]) {
  assert(!has(second, stillAbsent), `${stillAbsent} appeared without its own plugin`);
}
// A broken serializer would emit frontmatter with an empty description, which loads but never fires.
const mobileSkill = fs.readFileSync(path.join(second, 'skills/mobile-locators/SKILL.md'), 'utf8');
assert(/^description: \S/m.test(mobileSkill), 'mobile-locators has no usable description');

console.log('[smoke] removing the fake plugin — the mobile pieces must go…');
fs.rmSync(fake, { recursive: true, force: true });
const third = render(project);
assert(!has(third, 'agents/mobile-vv.md'), 'mobile-vv survived removing the plugin');
assert(!has(third, 'skills/mobile-locators'), 'mobile-locators survived removing the plugin');

console.log('[smoke] asserting idempotence — two renders, byte-identical…');
const digest = dir =>
  fileList(dir)
    .map(rel => `${rel}\n${fs.readFileSync(path.join(dir, rel), 'utf8')}`)
    .join('\0');
const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-agents-out2-'));
assert(
  digest(third) === digest(render(project, { outRoot: otherRoot })),
  'two renders of the same input differ — that reloads the plugin mid-session and costs the prompt cache',
);

console.log('[smoke] rendering with no project resolvable at all…');
// A fresh home so the registry written by the scaffold above cannot resolve a project: this is the
// path a brand-new user hits before ever running create-pwtap.
const baseline = render(null, {
  home: fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-agents-empty-home-')),
});
assert(path.basename(baseline) === 'none', `expected the baseline directory, got ${baseline}`);
assert(has(baseline, 'agents/vv-lead.md'), 'the baseline render must still be a usable plugin');
assert(
  /No pwtap project was resolved/.test(fs.readFileSync(path.join(baseline, 'README.md'), 'utf8')),
  'the baseline README must explain why the roster is short',
);

// The one conditional assertion in this suite, and it is conditional on purpose: hard-depending on
// the Claude CLI would break the runner for anyone who does not have it.
let validated = false;
try {
  execFileSync('claude', ['--version'], { stdio: 'ignore' });
  validated = true;
} catch {
  console.log('[smoke] claude CLI not found — skipping `claude plugin validate`');
}
if (validated) {
  console.log('[smoke] validating the rendered plugin with the Claude CLI…');
  run('claude', ['plugin', 'validate', third, '--strict']);
  // The marketplace manifest is validated by pointing at the repo root, not at .claude-plugin: the
  // CLI looks for `<dir>/.claude-plugin/marketplace.json`.
  if (fs.existsSync(path.join(root, '.claude-plugin', 'marketplace.json'))) {
    run('claude', ['plugin', 'validate', root, '--strict']);
  }
}

for (const dir of [home, outRoot, otherRoot, project]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[smoke] OK');
