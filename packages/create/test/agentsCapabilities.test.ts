/**
 * Capability detection — the test that proves gating. A plugin counts as installed only when its
 * `./manifest` export resolves from the project's own node_modules, which is the seam
 * `loadPluginManifest` uses, so the fixtures fake exactly that and nothing else.
 *
 * The fixture projects are built in a tmpdir rather than committed: `node_modules/` is in the repo's
 * .gitignore, so a committed fixture would vanish in CI and the test would silently stop proving
 * anything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { detect } from '../src/agents/capabilities.js';

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const CONFIG_WITH_ALLURE = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  reporter: [['html'], ['allure-playwright', { detail: true }]],
});
`;

const CONFIG_WITHOUT_ALLURE = `import { defineConfig } from '@playwright/test';
export default defineConfig({ reporter: [['html'], ['list']] });
`;

interface ProjectSpec {
  /** Plugin packages to make resolvable, as `[package, manifestId]`. */
  installed?: Array<[string, string]>;
  /** Plugin packages listed in devDependencies but deliberately not installed. */
  declaredOnly?: string[];
  testsDir?: string;
  allure?: boolean;
  workflows?: boolean;
  git?: boolean;
  /** Write no package.json at all. */
  bare?: boolean;
  /** Write a package.json with none of the three pwtap signals. */
  foreign?: boolean;
}

function project(spec: ProjectSpec): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-caps-'));
  roots.push(root);
  if (spec.bare) {
    return root;
  }

  const devDependencies: Record<string, string> = { '@playwright/test': '^1.61.0' };
  for (const pkg of spec.declaredOnly ?? []) {
    devDependencies[pkg] = '^1.0.0';
  }
  for (const [pkg] of spec.installed ?? []) {
    devDependencies[pkg] = '^1.0.0';
  }

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      spec.foreign
        ? { name: 'not-pwtap', devDependencies: { vitest: '^2.0.0' } }
        : {
            name: 'client',
            scripts: { test: 'playwright test', 'test:api': 'playwright test --project=api' },
            devDependencies,
            ...(spec.testsDir === undefined ? {} : { pwtap: { testsDir: spec.testsDir } }),
          },
      null,
      2,
    ),
  );

  if (!spec.foreign) {
    fs.writeFileSync(
      path.join(root, 'playwright.config.ts'),
      spec.allure === false ? CONFIG_WITHOUT_ALLURE : CONFIG_WITH_ALLURE,
    );
  }
  if (spec.workflows) {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  }
  if (spec.git) {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  }

  // A resolvable `<pkg>/manifest` is the entire contract a plugin has to satisfy here.
  for (const [pkg, id] of spec.installed ?? []) {
    const dir = path.join(root, 'node_modules', ...pkg.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: pkg,
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js', './manifest': './manifest.js' },
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'export default {};\n');
    fs.writeFileSync(
      path.join(dir, 'manifest.js'),
      `export const manifest = { id: '${id}', name: '${pkg}', devDependencies: {}, scripts: {}, envKeys: {} };\n`,
    );
  }
  return root;
}

test('a core-only project gets core plus the derived tokens its files justify', async () => {
  const caps = await detect(project({ git: true, workflows: false }));
  assert.ok(caps);
  assert.deepEqual([...caps.tokens].sort(), ['cap:allure', 'cap:git', 'core']);
  assert.deepEqual(caps.plugins, {});
  assert.equal(caps.testsDir, 'tests');
  assert.deepEqual(caps.warnings, []);
});

test('a resolvable mobile plugin yields its own token and cap:mobile', async () => {
  const caps = await detect(project({ installed: [['@pwtap/plugin-appium', 'appium']] }));
  assert.ok(caps);
  assert.ok(caps.tokens.has('plugin:appium'));
  assert.ok(caps.tokens.has('cap:mobile'));
  assert.equal(caps.plugins.appium?.name, '@pwtap/plugin-appium');
});

test('either mobile plugin alone is enough for cap:mobile', async () => {
  const caps = await detect(project({ installed: [['@pwtap/plugin-maestro', 'maestro']] }));
  assert.ok(caps?.tokens.has('cap:mobile'));
  assert.equal(caps?.tokens.has('plugin:appium'), false);
});

test('a non-mobile plugin does not imply cap:mobile', async () => {
  const caps = await detect(project({ installed: [['@pwtap/plugin-db', 'db']] }));
  assert.ok(caps?.tokens.has('plugin:db'));
  assert.equal(caps?.tokens.has('cap:mobile'), false);
});

test('a devDependency that does not resolve is not installed — token absent, warning present', async () => {
  const caps = await detect(project({ declaredOnly: ['@pwtap/plugin-perf'] }));
  assert.ok(caps);
  assert.equal(caps.tokens.has('plugin:perf'), false);
  assert.equal(caps.warnings.length, 1);
  assert.match(caps.warnings[0], /@pwtap\/plugin-perf .*does not resolve.*npm install/);
});

test('an installed plugin produces no warning', async () => {
  const caps = await detect(project({ installed: [['@pwtap/plugin-perf', 'perf']] }));
  assert.deepEqual(caps?.warnings, []);
});

test('a recorded testsDir is read, not guessed', async () => {
  assert.equal((await detect(project({ testsDir: 'e2e' })))?.testsDir, 'e2e');
});

test('cap:ci-github follows .github/workflows', async () => {
  assert.equal((await detect(project({ workflows: true })))?.tokens.has('cap:ci-github'), true);
  assert.equal((await detect(project({ workflows: false })))?.tokens.has('cap:ci-github'), false);
});

test('cap:allure disappears when the reporter is removed from the config', async () => {
  assert.equal((await detect(project({ allure: false })))?.tokens.has('cap:allure'), false);
});

test('scripts are collected for interpolation, and are not tokens', async () => {
  const caps = await detect(project({}));
  assert.deepEqual(caps?.scripts, ['test', 'test:api']);
  assert.equal(
    [...(caps?.tokens ?? [])].some(token => token.includes('test:api')),
    false,
  );
});

test('a directory that is not a project is null — a baseline render, not an error', async () => {
  assert.equal(await detect(project({ bare: true })), null);
  assert.equal(await detect(project({ foreign: true })), null);
  assert.equal(await detect(path.join(os.tmpdir(), 'pwtap-does-not-exist-at-all')), null);
});

test('projectDir is absolute even when a relative path is given', async () => {
  const root = project({});
  const caps = await detect(path.relative(process.cwd(), root));
  assert.ok(caps);
  assert.ok(path.isAbsolute(caps.projectDir));
  // realpath on both sides: on macOS the tmpdir is reached through a /var → /private/var symlink.
  assert.equal(fs.realpathSync(caps.projectDir), fs.realpathSync(root));
});
