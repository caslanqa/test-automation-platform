#!/usr/bin/env node

/**
 * CLI tool to scaffold a new Playwright AI Distro project.
 *
 * Mirrors the official Playwright install experience:
 *
 *   npm  init  @caslanqa/playwright-ai@latest my-project
 *   npm  create @caslanqa/playwright-ai@latest my-project
 *   npx  @caslanqa/create-playwright-ai my-project
 *   yarn create @caslanqa/playwright-ai my-project
 *   pnpm create @caslanqa/playwright-ai my-project
 *
 * Runs an interactive menu (when stdin is a TTY) to choose the project
 * directory, GitHub Actions workflow, and install options — like the official
 * `npm init playwright@latest`. In non-TTY contexts (CI, piped input) it skips
 * the prompts and uses defaults, so it never hangs.
 *
 * Flags (override the interactive prompts):
 *   --no-install    Skip "npm install" in the new project
 *   --no-browsers   Skip "npx playwright install" (browser binaries)
 *   --no-gha        Skip the GitHub Actions workflow
 *   -y, --yes       Accept all defaults without prompting
 *   -h, --help      Show usage
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const PACKAGE_NAME = '@caslanqa/create-playwright-ai';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const log = {
  info: msg => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: msg => console.log(`${colors.green}✔${colors.reset} ${msg}`),
  warn: msg => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: msg => console.log(`${colors.red}✖${colors.reset} ${msg}`),
  step: msg => console.log(`${colors.cyan}→${colors.reset} ${msg}`),
};

// Source directories copied recursively into the generated project — the SAME set the package
// ships (see package.json "files"), so the scaffold always matches this repo and can never drift
// out of date (the old hand-maintained file list did). `bin/` (the scaffolder itself), `templates/`
// (its gitignore is handled below) and `.github/` (optional, handled below) are excluded on purpose.
const DIRS_TO_COPY = [
  'api',
  'config',
  'env',
  'fixtures',
  'pages',
  'testData',
  'tests',
  'utils',
];

// Individual root-level files. Only the user-facing docs are copied (not framework-internal ones
// like PUBLISHING.md). Dotfiles that npm renames on publish (e.g. .gitignore -> .npmignore) are
// handled separately via the templates/ directory below.
const ROOT_FILES_TO_COPY = [
  'playwright.config.ts',
  'tsconfig.json',
  'eslint.config.js',
  '.prettierrc',
  '.commitlintrc.json',
  'docs/AI_JUDGE.md',
  'docs/API_TESTING.md',
];

// GitHub Actions workflow — copied only when the user keeps CI (see includeGha).
const GHA_WORKFLOW = '.github/workflows/ci.yml';

// Injected into the generated README (templates/README.md {{MOBILE_SECTION}}) only when mobile is
// opted in; replaced with '' otherwise so opted-out projects don't document a feature they lack.
const MOBILE_README_SECTION = `
### Mobile test (Maestro)

Requires the [Maestro](https://maestro.mobile.dev) CLI + Java 17+ and a device (Android emulator or
iOS simulator). Mobile tests read like the UI/API tests: pick a device with \`test.use({ mobile: { platform, device } })\`,
then drive it either imperatively — \`await maestro.tapOn('Login')\`, with \`isVisible\` for live-screen
branching — or with a Maestro YAML flow via \`maestro.run('…')\` (see \`tests/mobile/*.mobile.ts\`). The
named device is auto-booted if it isn't running:

\`\`\`bash
npm run test:mobile   # MOBILE=1 playwright test --project=mobile --workers=3
\`\`\`

No device yet? \`npm run mobile:create-device\` builds one from your installed SDK/Xcode (interactive
picker). Android also needs the command-line tools (macOS/Windows/Linux, GUI or CLI) — see
[docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md#installing-the-android-command-line-tools).
`;

// package.json for the generated project. devDependencies are read from THIS
// package's own package.json so the copied configs (eslint/prettier/playwright)
// always get matching, complete dependencies — single source of truth, no drift.
// `meta` (version/description/author/license) comes from the interactive `npm init`-style prompts.
const createPackageJson = (projectName, devDependencies, includeMobile, meta = {}) => ({
  name: projectName,
  version: meta.version || '1.0.0',
  description: meta.description || 'Playwright test automation with AI Judge capabilities',
  // The copied configs (eslint.config.js, playwright.config.ts) use ESM syntax,
  // so the project must be an ES module package.
  type: 'module',
  // Kept in sync with this repo's own package.json scripts (the template). Mobile scripts are the
  // only conditional ones — mobile testing is opt-in in the scaffolder.
  scripts: {
    clearReports: 'rm -rf playwright-report test-results allure-report allure-results',
    test: 'playwright test',
    'test:headed': 'playwright test --headed',
    'test:debug': 'playwright test --debug',
    'test:ui': 'playwright test --ui',
    'test:parallel': 'playwright test --workers=4',
    'test:serial': 'playwright test --workers=1',
    'test:api': 'playwright test --project=api',
    ...(includeMobile
      ? {
          'test:mobile': 'MOBILE=1 playwright test --project=mobile --workers=3',
          'mobile:create-device': 'node mobile/create-device.mjs',
        }
      : {}),
    'test:tag': 'playwright test --workers=1 --project chromium --retries=0 --grep @wip',
    'report:playwright': 'playwright show-report',
    'report:allure':
      'allure generate allure-results --output allure-report && allure serve allure-results',
    codegen: 'playwright codegen',
    lint: 'eslint .',
    'lint:fix': 'eslint . --fix',
    format: 'prettier --write "**/*.{ts,js,json,md}"',
    'format:check': 'prettier --check "**/*.{ts,js,json,md}"',
    'type-check': 'tsc --noEmit',
    commit: 'cz',
    prepare: 'husky',
  },
  ...(meta.keywords && meta.keywords.length ? { keywords: meta.keywords } : {}),
  ...(meta.author ? { author: meta.author } : {}),
  license: meta.license || 'ISC',
  ...(meta.repository ? { repository: { type: 'git', url: meta.repository } } : {}),
  devDependencies,
  'lint-staged': {
    '*.{ts,tsx,js}': ['eslint --fix', 'prettier --write'],
    '*.{json,md}': ['prettier --write'],
  },
});

// Get the installed package root. When run via npx/npm-init the bin lives at
// <packageRoot>/bin/create-project.cjs, so the root is one level up.
function getPackageRoot() {
  let dir = __dirname;

  if (fs.existsSync(path.join(dir, '..', 'package.json'))) {
    return path.join(dir, '..');
  }

  // Fallback: walk up looking for the installed package under node_modules
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'node_modules', PACKAGE_NAME);
    if (fs.existsSync(pkgPath)) {
      return pkgPath;
    }
    dir = path.dirname(dir);
  }

  return path.join(__dirname, '..');
}

// Read this package's own devDependencies — used as the template for the
// generated project so the copied configs have everything they need.
function readTemplateDevDependencies(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return pkg.devDependencies || {};
  } catch {
    return {};
  }
}

// Copy a single file, creating parent directories as needed.
function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    return true;
  }
  return false;
}

// Count files under a directory tree (recursively) — for the "Copied N files" summary.
function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}

// Run a child command in the target dir. npm_* env vars leaked from the parent
// `npm init`/`npx` process can break a nested `npm install`, so strip them.
function run(command, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_')) {
      delete env[key];
    }
  }
  execSync(command, { cwd, stdio: 'inherit', env });
}

// Whether an executable is resolvable on PATH.
function commandExists(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// Best-effort, cross-platform install of the Maestro CLI (the mobile engine). Skips when already
// installed; warns (never fails) on missing Java or a failed install. macOS/Linux use Maestro's
// official installer script; Windows needs a POSIX shell (WSL / Git Bash) to run it, else we point
// the user to the docs.
function installMaestroCli(cwd) {
  if (commandExists('maestro')) {
    log.success('Maestro CLI already installed');
    return;
  }
  if (!commandExists('java')) {
    log.warn(
      'Java not found — Maestro needs Java 17+ at runtime; install a JDK before running mobile tests.'
    );
  }
  const installScript = 'curl -Ls "https://get.maestro.mobile.dev" | bash';
  try {
    if (process.platform === 'win32') {
      if (!commandExists('bash')) {
        log.warn(
          'Maestro auto-install on Windows needs WSL or Git Bash — install manually: https://maestro.mobile.dev'
        );
        return;
      }
      log.step('Installing Maestro CLI (via bash)...');
      run(`bash -lc '${installScript}'`, cwd);
    } else {
      log.step('Installing Maestro CLI...');
      run(installScript, cwd);
    }
    log.success('Installed Maestro CLI (restart your shell, or add ~/.maestro/bin to PATH)');
  } catch {
    log.warn('Maestro install failed — install it manually: https://maestro.mobile.dev');
  }
}

// Candidate Android SDK roots (env vars, then the per-OS default install location). Mirrors
// mobile/core/android.ts so our checks match where the framework actually resolves the SDK.
function androidSdkRoots() {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : undefined,
    process.platform === 'linux' ? path.join(home, 'Android', 'Sdk') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
  ].filter(Boolean);
}

// Whether `adb` exists in the standard Android SDK location. The framework resolves adb from the SDK
// at runtime even when it isn't on PATH (mobile/core/android.ts), so a SDK-resident adb counts.
function androidSdkAdbExists() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  return androidSdkRoots().some(root => fs.existsSync(path.join(root, 'platform-tools', exe)));
}

// Whether the Android SDK Command-line Tools (sdkmanager/avdmanager) are available — on PATH, or under
// a standard SDK's `cmdline-tools/latest/bin`. Required by `npm run mobile:create-device` to create AVDs.
function androidCmdlineToolsExist() {
  if (commandExists('sdkmanager')) {
    return true;
  }
  const bin = process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager';
  return androidSdkRoots().some(root =>
    fs.existsSync(path.join(root, 'cmdline-tools', 'latest', 'bin', bin))
  );
}

// Best-effort, cross-platform ensure of `adb` (Android mobile testing). Present when on PATH or in the
// SDK. Otherwise install via the first available NON-admin package manager for the OS (macOS/Linux
// Homebrew, Windows scoop/winget); if none is available we only PRINT the right command (never run
// sudo/admin installs unattended, which would hang or need elevation). Never fails the scaffold.
function ensureAdb(cwd) {
  if (commandExists('adb') || androidSdkAdbExists()) {
    log.success('adb already available');
    return;
  }
  let plan;
  if (process.platform === 'win32') {
    plan = commandExists('scoop')
      ? 'scoop install adb'
      : commandExists('winget')
        ? 'winget install --id Google.PlatformTools -e --silent'
        : undefined;
  } else if (commandExists('brew')) {
    // macOS, and Linux with Homebrew.
    plan = 'brew install android-platform-tools';
  }
  if (plan) {
    try {
      log.step(`Installing adb (${plan})...`);
      run(plan, cwd);
      log.success('Installed adb');
      return;
    } catch {
      log.warn(`adb install failed (${plan}) — install it manually.`);
      return;
    }
  }
  const manual =
    process.platform === 'win32'
      ? 'scoop install adb  (or: winget install Google.PlatformTools)'
      : process.platform === 'darwin'
        ? 'brew install android-platform-tools'
        : 'sudo apt-get install -y android-tools-adb  (or dnf/pacman/zypper equivalent)';
  log.warn(`adb not found — install the Android platform-tools: ${manual}. (The Android SDK already bundles adb.)`);
}

// Best-effort ensure of the Android SDK Command-line Tools (sdkmanager/avdmanager), which
// `mobile:create-device` needs to create AVDs. Auto-installs where a package manager makes it feasible
// without admin (macOS Homebrew cask, Windows scoop); otherwise prints install guidance (there is no
// universal no-admin installer — bootstrapping the tools elsewhere means the manual SDK download).
function ensureAndroidCmdlineTools(cwd) {
  if (androidCmdlineToolsExist()) {
    log.success('Android SDK command-line tools already installed');
    return;
  }
  let plan;
  if (process.platform === 'darwin' && commandExists('brew')) {
    plan = 'brew install --cask android-commandlinetools';
  } else if (process.platform === 'win32' && commandExists('scoop')) {
    plan = 'scoop install android-clt';
  }
  if (plan) {
    try {
      log.step(`Installing Android SDK command-line tools (${plan})...`);
      run(plan, cwd);
      log.success('Installed Android SDK command-line tools');
      return;
    } catch {
      log.warn(`Command-line tools install failed (${plan}).`);
    }
  }
  log.warn(
    'Android SDK command-line tools not found — needed by `npm run mobile:create-device` to create AVDs. ' +
      'Install via Android Studio (SDK Manager → SDK Tools → "Android SDK Command-line Tools"), or see ' +
      'docs/MOBILE_TESTING.md#installing-the-android-command-line-tools.'
  );
}

// Best-effort, cross-platform ensure of the Allure CLI — used by the `allure` reporter and the
// `report:allure` script, independent of mobile. Installed via a global npm install: the
// `allure-commandline` package ships the CLI and works on every OS with no package manager or admin.
function ensureAllureCli(cwd) {
  if (commandExists('allure')) {
    log.success('Allure CLI already installed');
    return;
  }
  try {
    log.step('Installing Allure CLI (npm install -g allure-commandline)...');
    run('npm install -g allure-commandline', cwd);
    log.success('Installed Allure CLI');
  } catch {
    log.warn(
      'Allure CLI install failed — install manually: npm i -g allure-commandline (or brew/scoop install allure).'
    );
  }
}

// Minimal readline-based prompts (zero dependencies). Used only when stdin is a
// TTY; otherwise callers fall back to defaults so the scaffolder never hangs.
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = q => new Promise(resolve => rl.question(q, resolve));
  return {
    async text(label, def) {
      const suffix = def ? ` ${colors.reset}(${def})` : '';
      const ans = (await question(`${colors.cyan}?${colors.reset} ${label}${suffix}: `)).trim();
      return ans || def || '';
    },
    async confirm(label, def = true) {
      const hint = def ? 'Y/n' : 'y/N';
      const ans = (await question(`${colors.cyan}?${colors.reset} ${label} (${hint}) `)).trim().toLowerCase();
      if (!ans) {
        return def;
      }
      return ans[0] === 'y';
    },
    close() {
      rl.close();
    },
  };
}

function printHelp() {
  console.log(`
${colors.cyan}@caslanqa/create-playwright-ai${colors.reset} — scaffold a Playwright + AI Judge project

${colors.cyan}Usage:${colors.reset}
  npm init @caslanqa/playwright-ai@latest ${colors.cyan}[project-dir]${colors.reset}
  npx @caslanqa/create-playwright-ai ${colors.cyan}[project-dir]${colors.reset}

${colors.cyan}Options:${colors.reset}
  --no-install     Skip installing npm dependencies
  --no-browsers    Skip installing Playwright browser binaries
  --no-gha         Skip the GitHub Actions workflow
  --mobile         Include mobile testing (Maestro); when installing, checks/installs adb + Maestro CLI
  -y, --yes        Accept all defaults without prompting (no interactive menu)
  -h, --help       Show this help
`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }

  // Explicit flags always win over the interactive menu.
  const flagNoInstall = argv.includes('--no-install');
  const flagNoBrowsers = argv.includes('--no-browsers');
  const flagNoGha = argv.includes('--no-gha');
  const flagMobile = argv.includes('--mobile');
  const flagYes = argv.includes('--yes') || argv.includes('-y');
  // First non-flag argument is the project directory.
  const positional = argv.find(a => !a.startsWith('-'));

  // Interactive only when attached to a real terminal and not in --yes mode.
  const interactive = Boolean(process.stdin.isTTY) && !flagYes;

  console.log(`
${colors.cyan}╔═══════════════════════════════════════════════════════╗
║     🎭 Playwright AI Distro - Project Scaffolder 🤖    ║
╚═══════════════════════════════════════════════════════╝${colors.reset}
`);

  // --- Interactive menu (like official create-playwright) ---
  let projectName = positional;
  let includeGha = !flagNoGha;
  let includeMobile = flagMobile;
  let doInstall = !flagNoInstall;
  let doBrowsers = !flagNoBrowsers;
  // package.json metadata — the `npm init`-style questions. Defaults used in --yes / non-TTY mode.
  const meta = {
    version: '1.0.0',
    description: 'Playwright test automation with AI Judge capabilities',
    author: '',
    license: 'ISC',
    keywords: [],
    repository: '',
  };

  if (interactive) {
    const prompt = createPrompter();
    try {
      if (!projectName) {
        projectName = await prompt.text("Project directory name ('.' for current dir)", '.');
      }
      // package.json metadata (like `npm init`).
      meta.version = await prompt.text('Version', meta.version);
      meta.description = await prompt.text('Description', meta.description);
      meta.author = await prompt.text('Author', meta.author);
      meta.license = await prompt.text('License', meta.license);
      meta.keywords = (await prompt.text('Keywords (comma-separated)', ''))
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);
      meta.repository = await prompt.text('Git repository URL', meta.repository);
      if (!flagNoGha) {
        includeGha = await prompt.confirm('Add a GitHub Actions workflow?', true);
      }
      if (!flagMobile) {
        includeMobile = await prompt.confirm('Add mobile testing (Maestro flows)?', false);
      }
      if (!flagNoInstall) {
        doInstall = await prompt.confirm('Install npm dependencies now?', true);
      }
      if (!flagNoBrowsers && doInstall) {
        doBrowsers = await prompt.confirm('Install Playwright browsers?', true);
      }
    } finally {
      prompt.close();
    }
  }

  if (!projectName) {
    projectName = '.';
  }
  // Browsers can only be installed if dependencies are installed.
  if (!doInstall) {
    doBrowsers = false;
  }

  const isCurrentDir = projectName === '.' || projectName === './';
  const targetDir = isCurrentDir
    ? process.cwd()
    : path.resolve(process.cwd(), projectName);

  // Refuse to scaffold into an existing, non-empty named directory.
  if (!isCurrentDir && fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir).filter(e => e !== '.git');
    if (entries.length > 0) {
      log.error(`Directory "${projectName}" already exists and is not empty.`);
      process.exit(1);
    }
  }

  const displayName = isCurrentDir ? path.basename(targetDir) : projectName;
  log.info(`Creating project: ${colors.cyan}${displayName}${colors.reset}`);

  fs.mkdirSync(targetDir, { recursive: true });
  if (!isCurrentDir) {
    log.success('Created project directory');
  }

  const packageRoot = getPackageRoot();
  log.step('Copying files from template...');

  let copiedCount = 0;

  // Whole source directories (recursive) — mirrors package.json "files", so nothing is missed.
  for (const dir of DIRS_TO_COPY) {
    const src = path.join(packageRoot, dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(targetDir, dir), { recursive: true });
      copiedCount += countFiles(src);
    } else {
      log.warn(`Directory not found: ${dir}`);
    }
  }

  // Root-level config files.
  for (const file of ROOT_FILES_TO_COPY) {
    if (copyFile(path.join(packageRoot, file), path.join(targetDir, file))) {
      copiedCount++;
    } else {
      log.warn(`File not found: ${file}`);
    }
  }

  // GitHub Actions workflow, unless the user opted out.
  if (includeGha && copyFile(path.join(packageRoot, GHA_WORKFLOW), path.join(targetDir, GHA_WORKFLOW))) {
    copiedCount++;
  }

  // Mobile testing (Maestro) — opt-in. `tests/mobile` shipped as part of `tests/` above; keep it only
  // when opted in and add the `mobile/` engine + its doc. Otherwise strip `tests/mobile` so the
  // config's existsSync guard leaves the `mobile` project unregistered.
  if (includeMobile) {
    const mobileSrc = path.join(packageRoot, 'mobile');
    if (fs.existsSync(mobileSrc)) {
      fs.cpSync(mobileSrc, path.join(targetDir, 'mobile'), { recursive: true });
      copiedCount += countFiles(mobileSrc);
    }
    for (const doc of ['docs/MOBILE_TESTING.md', 'docs/MOBILE_CHEATSHEET.md']) {
      if (copyFile(path.join(packageRoot, doc), path.join(targetDir, doc))) {
        copiedCount++;
      }
    }
  } else {
    fs.rmSync(path.join(targetDir, 'tests', 'mobile'), { recursive: true, force: true });
  }

  log.success(`Copied ${copiedCount} files`);

  // .gitignore is shipped as templates/gitignore because npm renames a literal
  // .gitignore to .npmignore when publishing. Write it back out with the dot.
  const gitignoreSrc = path.join(packageRoot, 'templates', 'gitignore');
  if (fs.existsSync(gitignoreSrc)) {
    fs.copyFileSync(gitignoreSrc, path.join(targetDir, '.gitignore'));
    log.success('Created .gitignore');
  } else {
    log.warn('Template gitignore not found; skipping .gitignore');
  }

  // package.json (devDependencies derived from this package — single source of truth)
  const devDependencies = readTemplateDevDependencies(packageRoot);
  const pkgName = isCurrentDir ? path.basename(targetDir) : projectName;
  const pkgJson = createPackageJson(pkgName, devDependencies, includeMobile, meta);
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
  log.success('Created package.json');

  // README.md — rendered from templates/README.md with the project name substituted.
  const readmeTemplate = path.join(packageRoot, 'templates', 'README.md');
  if (fs.existsSync(readmeTemplate)) {
    const readme = fs
      .readFileSync(readmeTemplate, 'utf8')
      .replace(/\{\{PROJECT_NAME\}\}/g, pkgName)
      .replace(/\{\{MOBILE_SECTION\}\}/g, includeMobile ? MOBILE_README_SECTION : '');
    fs.writeFileSync(path.join(targetDir, 'README.md'), readme);
    log.success('Created README.md');
  } else {
    log.warn('Template README not found; skipping README.md');
  }

  // .auth directory (auth state is generated at runtime)
  fs.mkdirSync(path.join(targetDir, '.auth'), { recursive: true });
  log.success('Created .auth directory');

  // NOTE: the real config files (env/environments.json, testData/users.json) are intentionally NOT
  // created here — they are gitignored, machine-local, and often hold credentials. The user copies
  // them from the shipped *.example.json (see the `cp` lines in "Next steps" below) and edits them.

  // Husky git hooks — activated by the generated project's `prepare: husky` on install: run
  // lint-staged before each commit and commitlint on the commit message. (lint-staged config lives
  // in package.json, commitlint config in .commitlintrc.json — both scaffolded above.)
  const huskyDir = path.join(targetDir, '.husky');
  fs.mkdirSync(huskyDir, { recursive: true });
  const huskyHooks = {
    'pre-commit': 'npx lint-staged\n',
    'commit-msg': 'npx --no -- commitlint --edit "$1"\n',
  };
  for (const [hookName, hookBody] of Object.entries(huskyHooks)) {
    const hookPath = path.join(huskyDir, hookName);
    fs.writeFileSync(hookPath, hookBody);
    try {
      fs.chmodSync(hookPath, '755');
    } catch {
      // Ignore chmod errors (e.g. on Windows)
    }
  }
  log.success('Created husky hooks (pre-commit, commit-msg)');

  // Initialize a git repo before installing, so husky can wire up its hooks during `prepare`
  // (husky needs a .git dir). Best-effort — if git is missing or it's already a repo, skip.
  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    try {
      run('git init -q', targetDir);
      log.success('Initialized git repository');
    } catch {
      log.warn('git not available — run "git init" later so husky hooks activate.');
    }
  }

  // --- Match official create-playwright: install deps + browsers per choices ---
  let installed = false;
  if (doInstall) {
    try {
      log.step('Installing dependencies (npm install)...');
      run('npm install', targetDir);
      installed = true;
      log.success('Installed dependencies');
    } catch {
      log.warn('npm install failed — run it manually in the project directory.');
    }
  }

  if (doBrowsers && installed) {
    try {
      log.step('Installing Playwright browsers (npx playwright install)...');
      run('npx playwright install', targetDir);
      log.success('Installed Playwright browsers');
    } catch {
      log.warn('Browser install failed — run "npx playwright install" manually.');
    }
  }

  // CLI tooling (only while installing — respects --no-install). Allure powers the `allure` reporter
  // and `report:allure` for EVERY project, independent of mobile. When mobile is included, also make
  // sure adb + the Maestro CLI are present (checked first, installed only if missing).
  if (doInstall) {
    ensureAllureCli(targetDir);
    if (includeMobile) {
      ensureAdb(targetDir);
      ensureAndroidCmdlineTools(targetDir);
      installMaestroCli(targetDir);
    }
  }

  // --- Next steps: only show what the user still needs to run ---
  const steps = [];
  if (!isCurrentDir) {
    steps.push(`cd ${projectName}`);
  }
  if (!installed) {
    steps.push('npm install');
  }
  if (!doBrowsers || !installed) {
    steps.push('npx playwright install');
  }
  // Create the machine-local config from the shipped examples, then edit + run.
  steps.push('cp env/environments.example.json env/environments.json    # then set BASE_URL / API_BASE_URL');
  steps.push('cp testData/users.example.json testData/users.json        # then set your login sessions');
  // Allure CLI powers `report:allure`; surface it if it still isn't available (skipped / failed install).
  if (!commandExists('allure')) {
    steps.push('npm i -g allure-commandline    # Allure CLI (used by report:allure)');
  }
  steps.push('npm test');
  const manualSteps = steps.map(s => `\n  ${colors.yellow}${s}${colors.reset}`).join('');

  const maestroStep = doInstall
    ? `Maestro was checked/installed — if just installed, restart your shell (or add ${colors.yellow}~/.maestro/bin${colors.reset} to PATH). Docs: ${colors.blue}https://maestro.mobile.dev${colors.reset}`
    : `Install Maestro: ${colors.blue}https://maestro.mobile.dev${colors.reset}  (needs Java 17+)`;
  const mobileHelp = includeMobile
    ? `
${colors.cyan}For Mobile testing (Maestro):${colors.reset}

  1. ${maestroStep}
  2. Boot a device (Android emulator or iOS simulator)
  3. Set MOBILE_PLATFORM (android|ios) in env/environments.json
  4. ${colors.yellow}npm run test:mobile${colors.reset}
`
    : '';

  console.log(`
${colors.green}✨ Project created successfully!${colors.reset}

${colors.cyan}Next steps:${colors.reset}${manualSteps}

${colors.cyan}For AI Judge:${colors.reset}

  1. Install Ollama: ${colors.blue}https://ollama.com${colors.reset}
  2. ${colors.yellow}ollama serve${colors.reset}  (then pull a model, e.g. ${colors.yellow}ollama pull qwen3.5${colors.reset})
  3. ${colors.yellow}npx playwright test tests/example/aiJudge.spec.ts${colors.reset}
${mobileHelp}
${colors.cyan}Documentation:${colors.reset}
  - AI Judge Guide: ${colors.blue}docs/AI_JUDGE.md${colors.reset}${includeMobile ? `\n  - Mobile Testing: ${colors.blue}docs/MOBILE_TESTING.md${colors.reset}` : ''}
  - Playwright Docs: ${colors.blue}https://playwright.dev${colors.reset}

Happy testing! 🎭
`);
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
