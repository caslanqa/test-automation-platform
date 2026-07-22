import fs from 'node:fs';
import path from 'node:path';

import { loadCoreManifest } from '../manifest.js';
import { addPlugins } from '../plugin-apply.js';
import { Prompter } from '../prompts.js';
import { KNOWN_PLUGINS } from '../registry.js';
import { copyDir, exists, isEmptyDir, sortObject, writeJson } from '../util/fs.js';
import { log } from '../util/log.js';
import { run } from '../util/run.js';

export interface CreateOptions {
  targetDir: string;
  yes: boolean;
  install: boolean;
  browsers: boolean;
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

  // 2. Gather project name + plugin choices.
  const prompter = new Prompter(opts.yes);
  let name: string;
  let selectedIds: string[];
  try {
    name = await prompter.text('Project name', path.basename(targetDir));
    selectedIds =
      opts.selectedPluginIds.length > 0
        ? opts.selectedPluginIds
        : await prompter.selectPlugins(KNOWN_PLUGINS);
  } finally {
    prompter.close();
  }

  // 3. Write the base package.json from the core manifest.
  writeBasePackageJson(targetDir, name, coreManifestPath);

  // 4. git init + husky hooks so commit hygiene (lint-staged + commitlint) activates on install.
  await initGit(targetDir);
  writeHuskyHooks(targetDir);

  // 5. Install core deps, then plugins (install + inject), then browsers.
  if (opts.install) {
    log.step('Installing dependencies');
    await run('npm', ['install'], { cwd: targetDir });
  }
  if (selectedIds.length > 0) {
    await addPlugins({ clientDir: targetDir, pluginIds: selectedIds, install: opts.install });
  }
  if (opts.browsers) {
    const core = loadCoreManifest(coreManifestPath);
    log.step(`Installing Playwright browsers: ${core.browsers.join(', ')}`);
    await run('npx', ['playwright', 'install', ...core.browsers], { cwd: targetDir }).catch(err =>
      log.warn(`playwright install skipped: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  printNextSteps(targetDir, name);
}

function writeBasePackageJson(targetDir: string, name: string, coreManifestPath: string): void {
  const core = loadCoreManifest(coreManifestPath);
  writeJson(path.join(targetDir, 'package.json'), {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: sortObject(core.scripts),
    devDependencies: sortObject(core.devDependencies),
    ...(core.packageJson ?? {}),
  });
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

function printNextSteps(targetDir: string, name: string): void {
  const rel = path.relative(process.cwd(), targetDir) || '.';
  log.done(`Created ${name}`);
  log.info(
    [
      '',
      'Next steps:',
      `  cd ${rel}`,
      '  cp env/environments.example.json env/environments.json   # set BASE_URL / API_BASE_URL',
      '  cp testData/users.example.json testData/users.json       # add login sessions (optional)',
      '  npm test                                                 # runs chromium + api',
      '',
      'Add a plugin later:  npx create-pwtap add <maestro|appium|...>',
    ].join('\n'),
  );
}
