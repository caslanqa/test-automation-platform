import fs from 'fs';
import path from 'path';

// Single source of truth for environment loading. Every consumer (envUtils, the fixtures,
// playwright.config) goes through loadEnv() so switching environments is a single variable change.
//
// All config lives in env/environments.json with two blocks:
//   {
//     "common":       { ...shared string keys, may contain ${TEST_ENV.X} tokens... },
//     "environments": { "<env>": { "BASE_URL": "...", ...other per-env scalars... } }
//   }
// The environment is selected via TEST_ENV (falls back to common.DEFAULT_TEST_ENV). loadEnv flattens
// every string scalar (from `common` and the selected environment block) into process.env, e.g.
// common.DEFAULT_TEST_ENV and environments.dev.BASE_URL both become process.env keys.
//
// Login credentials do NOT live here — named sessions are in testData/users.json and consumed
// directly by the auth fixtures (fixtures/auth.ts) when a session is first used.

const ENV_FILE = 'environments.json';

// Matches ${TEST_ENV.SOME_KEY} placeholders inside common string values; the key is resolved
// against the selected environment block (e.g. ${TEST_ENV.BASE_URL}).
const TEST_ENV_TOKEN = /\$\{TEST_ENV\.([A-Za-z0-9_]+)\}/g;

let loaded = false;
let resolvedEnv = '';

interface EnvConfig {
  common?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
}

/**
 * Convert a config key to its flat env-var form: camelCase becomes SCREAMING_SNAKE_CASE
 * (e.g. "supabaseUrl" -> "SUPABASE_URL"); an already upper/snake key is left unchanged.
 */
function toEnvKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Set a process.env key unless it is a documentation key (leading "_"/"$") or was already defined
 * explicitly (e.g. an exported CI secret), so an explicit value always wins over the file.
 */
function setEnv(key: string, value: string): void {
  if (key.startsWith('_') || key.startsWith('$')) {
    return;
  }
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

/**
 * Replace ${TEST_ENV.X} tokens in a string with the matching scalar from the selected environment
 * block. An unknown/missing key resolves to an empty string so a malformed template degrades
 * visibly rather than crashing the run.
 */
function resolveTokens(value: string, envBlock: Record<string, unknown>): string {
  return value.replace(TEST_ENV_TOKEN, (_match, key: string) => {
    const resolved = envBlock[key];
    return typeof resolved === 'string' ? resolved : '';
  });
}

/**
 * Load env/environments.json, flattening string scalars into process.env keys. Idempotent — safe to
 * call multiple times.
 *
 * Environment selection: TEST_ENV env var > common.DEFAULT_TEST_ENV fallback.
 *
 * @returns The name of the selected environment for logging/debugging.
 */
export function loadEnv(): string {
  if (loaded) {
    return resolvedEnv;
  }
  loaded = true;

  const file = path.join(process.cwd(), 'env', ENV_FILE);
  if (!fs.existsSync(file)) {
    console.warn(`[loadEnv] ${file} not found — skipping.`);
    return '';
  }

  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as EnvConfig;
  const common = config.common ?? {};

  // Determine environment: explicit TEST_ENV wins, else fallback from common.
  resolvedEnv = process.env.TEST_ENV ?? (common.DEFAULT_TEST_ENV as string) ?? '';

  const envBlock = config.environments?.[resolvedEnv] ?? {};

  // 1. Flatten common string scalars (resolve ${TEST_ENV.X} tokens against the env block).
  for (const [key, val] of Object.entries(common)) {
    if (typeof val === 'string') {
      setEnv(toEnvKey(key), resolveTokens(val, envBlock));
    }
  }

  // 2. Flatten the selected environment block's string scalars (BASE_URL, etc.).
  for (const [key, val] of Object.entries(envBlock)) {
    if (typeof val === 'string') {
      setEnv(toEnvKey(key), val);
    }
  }

  console.info(`[loadEnv] Loaded environment: ${resolvedEnv}`);
  return resolvedEnv;
}
