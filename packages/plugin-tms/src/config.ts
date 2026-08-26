/**
 * The provider-neutral half of the configuration: which tool, whether it is switched on, and which
 * environment the run is against. Anything tool-specific (a token, a project code, a base URL) is read
 * by the provider itself — see `providers/qase/config.ts`. That split is what keeps `TMS_*` from growing
 * a `QASE_` field the day a second provider lands.
 *
 * **`mode` defaults to `off`.** A bare `npx playwright test` in a project with this plugin installed
 * makes no network call at all, the same contract every other plugin's env-gated project honours.
 *
 * @example
 * // env/environments.json → common: { "TMS_PROVIDER": "qase", "TMS_MODE": "testops" }
 * const config = readConfig();
 * if (config.mode === 'testops') { … }
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** `off` makes every hook and every command inert. There is no third state on purpose. */
export type TmsMode = 'off' | 'testops';

export interface TmsConfig {
  /** Which provider module handles this project. `TMS_PROVIDER`, default `qase`. */
  provider: string;
  /** `TMS_MODE`. Anything other than `testops` is `off`. */
  mode: TmsMode;
  /** `TEST_ENV` — the environment block the run is against, for the run title and Qase's environment. */
  environment: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): TmsConfig {
  return {
    provider:
      env.TMS_PROVIDER?.trim() !== undefined && env.TMS_PROVIDER.trim() !== ''
        ? env.TMS_PROVIDER.trim()
        : 'qase',
    mode: env.TMS_MODE?.trim().toLowerCase() === 'testops' ? 'testops' : 'off',
    environment: env.TEST_ENV?.trim() ?? '',
  };
}

interface EnvFile {
  common?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
}

const TEST_ENV_TOKEN = /\$\{TEST_ENV\.([A-Za-z0-9_]+)\}/g;

/** camelCase → SCREAMING_SNAKE_CASE; an already-upper key is left alone. */
function toEnvKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Flatten `env/environments.json` onto `process.env`, for the CLI only.
 *
 * Inside a Playwright run this is already done: the scaffolded `playwright.config.ts` calls the client's
 * own `config/loadEnv.ts` before the config object is built, so the reporter just reads `process.env`.
 * The CLI runs outside that, and has to do it itself.
 *
 * ponytail: this duplicates ~30 lines of the client's `config/loadEnv.ts`. Importing that file instead
 * would mean type-stripping a TypeScript module out of a directory we do not own, at a Node version where
 * stripping still needs a flag — a runtime failure mode in exchange for saving thirty deterministic,
 * testable lines. Re-unify if the template ever ships a compiled loader.
 *
 * An explicitly-exported variable always wins over the file, so `QASE_TESTOPS_API_TOKEN=… npm run tms:sync`
 * works whatever the file says. Missing file is not an error — the caller may be fully env-configured.
 */
export function loadEnvFile(cwd: string = process.cwd()): string {
  const file = path.join(cwd, 'env', 'environments.json');
  if (!fs.existsSync(file)) {
    return '';
  }
  let parsed: EnvFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EnvFile;
  } catch {
    return '';
  }

  const common = parsed.common ?? {};
  const selected = process.env.TEST_ENV ?? (common.DEFAULT_TEST_ENV as string | undefined) ?? '';
  const block = parsed.environments?.[selected] ?? {};

  const set = (key: string, value: string): void => {
    if (key.startsWith('_') || key.startsWith('$') || process.env[key] !== undefined) {
      return;
    }
    process.env[key] = value;
  };

  for (const [key, value] of Object.entries(common)) {
    if (typeof value === 'string') {
      set(
        toEnvKey(key),
        value.replace(TEST_ENV_TOKEN, (_m, token: string) => {
          const resolved = block[token];
          return typeof resolved === 'string' ? resolved : '';
        }),
      );
    }
  }
  for (const [key, value] of Object.entries(block)) {
    if (typeof value === 'string') {
      set(toEnvKey(key), value);
    }
  }
  if (process.env.TEST_ENV === undefined && selected !== '') {
    process.env.TEST_ENV = selected;
  }
  return selected;
}

export interface GitContext {
  branch: string;
  sha: string;
}

function gitValue(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Branch and short SHA, or empty strings outside a repository. CI variables win, because a detached
 * HEAD — which is what most CI checkouts are — reports `HEAD` as its branch, and a run list full of
 * `HEAD` is a run list nobody can read.
 */
export function gitContext(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): GitContext {
  const branch =
    env.GITHUB_HEAD_REF ??
    env.GITHUB_REF_NAME ??
    env.CI_COMMIT_REF_NAME ??
    env.BRANCH_NAME ??
    gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return {
    branch: branch === 'HEAD' ? '' : branch,
    sha: (env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? gitValue(['rev-parse', 'HEAD'], cwd)).slice(0, 7),
  };
}

/**
 * The run title: `<branch> · <sha> · <env>`, with empty parts dropped, falling back to a bare
 * `Playwright run`. A fixed title makes yesterday's run and today's indistinguishable in the run list,
 * which is the one thing a run list is for.
 */
export function runTitle(config: TmsConfig, git: GitContext = gitContext()): string {
  const parts = [git.branch, git.sha, config.environment].filter(part => part !== '');
  return parts.length === 0 ? 'Playwright run' : parts.join(' · ');
}
