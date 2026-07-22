import fs from 'node:fs';
import path from 'node:path';

import { loadCoreManifest } from '../manifest.js';
import { addPlugins } from '../plugin-apply.js';
import { Prompter } from '../prompts.js';
import { KNOWN_PLUGINS } from '../registry.js';
import { copyDir, ensureDir, exists, isEmptyDir, sortObject, writeJson } from '../util/fs.js';
import { log } from '../util/log.js';
import { run } from '../util/run.js';

export interface CreateOptions {
  targetDir: string;
  yes: boolean;
  install: boolean;
  browsers: boolean;
  gha: boolean;
  testsDirDefault: string;
  selectedPluginIds: string[];
  templateDir: string;
  coreManifestPath: string;
}

/** Scaffold a new core project (UI + API), then optionally install/inject selected plugins. */
export async function createProject(opts: CreateOptions): Promise<void> {
  const { targetDir, templateDir, coreManifestPath } = opts;
  if (!isEmptyDir(targetDir)) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  log.step(`Scaffolding Playwright Test Automation Platform into ${targetDir}`);

  // 1. Copy the core template verbatim, then reveal the shipped gitignore as .gitignore.
  copyDir(templateDir, targetDir);
  const shippedGitignore = path.join(targetDir, 'templates', 'gitignore');
  if (exists(shippedGitignore)) {
    fs.renameSync(shippedGitignore, path.join(targetDir, '.gitignore'));
    fs.rmSync(path.join(targetDir, 'templates'), { recursive: true, force: true });
  }

  // 2. Gather answers — mirrors the official `npm init playwright` questions (minus TS/JS: this
  //    platform is TypeScript-only). Non-interactive (`-y` or no TTY) takes every default.
  const prompter = new Prompter(opts.yes);
  let name: string;
  let testsDir: string;
  let selectedIds: string[];
  let addGha: boolean;
  let installBrowsers: boolean;
  let installOsDeps: boolean;
  try {
    name = await prompter.text('Project name', path.basename(targetDir));
    testsDir = sanitizeDir(await prompter.text('Where to put your tests?', opts.testsDirDefault));
    selectedIds =
      opts.selectedPluginIds.length > 0
        ? opts.selectedPluginIds
        : await prompter.selectPlugins(KNOWN_PLUGINS);
    addGha = await prompter.confirm('Add a GitHub Actions workflow?', opts.gha);
    installBrowsers = await prompter.confirm('Install Playwright browsers?', opts.browsers);
    installOsDeps =
      process.platform === 'linux'
        ? await prompter.confirm(
            'Install Playwright operating system dependencies (requires sudo)?',
            false,
          )
        : false;
  } finally {
    prompter.close();
  }

  // 3. Relocate the tests folder if the user renamed it (repoints config + tsconfig + eslint globs).
  if (testsDir !== 'tests') {
    relocateTestsDir(targetDir, testsDir);
  }

  // 4. Write the base package.json from the core manifest (records testsDir so `add` places plugin
  //    examples in the right folder later).
  writeBasePackageJson(targetDir, name, coreManifestPath, testsDir);

  // 5. Optional GitHub Actions workflow for the scaffolded project.
  if (addGha) {
    writeGithubWorkflow(targetDir);
  }

  // 6. git init + husky hooks so commit hygiene (lint-staged + commitlint) activates on install.
  await initGit(targetDir);
  writeHuskyHooks(targetDir);

  // 7. Install core deps, then plugins (install + inject), then browsers / OS dependencies.
  if (opts.install) {
    log.step('Installing dependencies');
    await run('npm', ['install'], { cwd: targetDir });
  }
  if (selectedIds.length > 0) {
    await addPlugins({
      clientDir: targetDir,
      pluginIds: selectedIds,
      install: opts.install,
      testsDir,
    });
  }
  if (installBrowsers) {
    const core = loadCoreManifest(coreManifestPath);
    log.step(`Installing Playwright browsers: ${core.browsers.join(', ')}`);
    await run('npx', ['playwright', 'install', ...core.browsers], { cwd: targetDir }).catch(err =>
      log.warn(`playwright install skipped: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  if (installOsDeps) {
    log.step('Installing Playwright operating system dependencies');
    await run('npx', ['playwright', 'install-deps'], { cwd: targetDir }).catch(err =>
      log.warn(`install-deps skipped: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  printNextSteps(targetDir, name, testsDir);
}

/** Normalize a tests-folder answer to a safe relative dir; empty/invalid falls back to 'tests'. */
function sanitizeDir(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^[./]+/, '')
    .replace(/\/+$/, '');
  return cleaned === '' || cleaned.includes('..') ? 'tests' : cleaned;
}

/** Rename tests/ → <testsDir>/ and repoint the Playwright config, tsconfig alias, and eslint glob. */
function relocateTestsDir(targetDir: string, testsDir: string): void {
  const from = path.join(targetDir, 'tests');
  const to = path.join(targetDir, testsDir);
  if (exists(from)) {
    ensureDir(path.dirname(to));
    fs.renameSync(from, to);
  }
  patchFile(path.join(targetDir, 'playwright.config.ts'), s =>
    s.replaceAll('./tests', `./${testsDir}`),
  );
  patchFile(path.join(targetDir, 'tsconfig.json'), s => s.replace('"tests/*"', `"${testsDir}/*"`));
  patchFile(path.join(targetDir, 'eslint.config.js'), s =>
    s.replace("'tests/**/*.ts'", `'${testsDir}/**/*.ts'`),
  );
}

function patchFile(file: string, replacer: (content: string) => string): void {
  if (exists(file)) {
    fs.writeFileSync(file, replacer(fs.readFileSync(file, 'utf8')));
  }
}

function writeBasePackageJson(
  targetDir: string,
  name: string,
  coreManifestPath: string,
  testsDir: string,
): void {
  const core = loadCoreManifest(coreManifestPath);
  writeJson(path.join(targetDir, 'package.json'), {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: sortObject(core.scripts),
    devDependencies: sortObject(core.devDependencies),
    ...(core.packageJson ?? {}),
    pwtap: { testsDir },
  });
}

/** Standard Playwright CI — mirrors the workflow `npm init playwright` generates. */
function writeGithubWorkflow(targetDir: string): void {
  const dir = path.join(targetDir, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playwright.yml'), GITHUB_WORKFLOW);
}

async function initGit(targetDir: string): Promise<void> {
  // git init so husky's `prepare` can wire hooks during npm install (husky needs a .git dir).
  try {
    await run('git', ['init', '-q'], { cwd: targetDir });
  } catch {
    log.warn('git not available — run `git init` later so husky hooks activate.');
  }
}

function writeHuskyHooks(targetDir: string): void {
  // Hook files activated by the generated project's `prepare: husky` on install: lint-staged before
  // each commit, commitlint on the message.
  const dir = path.join(targetDir, '.husky');
  fs.mkdirSync(dir, { recursive: true });
  const hooks: Record<string, string> = {
    'pre-commit': 'npx lint-staged\n',
    'commit-msg': 'npx --no -- commitlint --edit "$1"\n',
  };
  for (const [hookName, body] of Object.entries(hooks)) {
    const hookPath = path.join(dir, hookName);
    fs.writeFileSync(hookPath, body);
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      // Ignore chmod failures (e.g. on Windows).
    }
  }
}

function printNextSteps(targetDir: string, name: string, testsDir: string): void {
  const rel = path.relative(process.cwd(), targetDir) || '.';
  log.done(`Created ${name}`);
  log.info(
    [
      '',
      'Next steps:',
      `  cd ${rel}`,
      '  cp env/environments.example.json env/environments.json   # set BASE_URL / API_BASE_URL',
      '  cp testData/users.example.json testData/users.json       # add login sessions (optional)',
      `  npm test                                                 # chromium + api (in ${testsDir}/)`,
      '',
      'Add a plugin later:  npx create-pwtap add <maestro|appium|ai-judge>',
    ].join('\n'),
  );
}

const GITHUB_WORKFLOW = `name: Playwright Tests
on:
  push:
    branches: [main, master]
  pull_request:
jobs:
  test:
    timeout-minutes: 60
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright browsers
        run: npx playwright install --with-deps
      - name: Run tests
        run: npm test
      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
`;
