/**
 * Reading `env/environments.json` from k6.
 *
 * This is the one place the two layers meet, and they meet as **data, not code**: k6 has its own JavaScript
 * runtime with no Node module resolution, so it cannot import `config/loadEnv.ts`, `pages/` or `api/` — those are
 * built on Playwright's `APIRequestContext` and `page` anyway. It reads the same JSON file with k6's `open()`.
 *
 * **`config/loadEnv.ts` is the authority for these semantics.** The rules mirrored here are: the environment is
 * `TEST_ENV` or `common.DEFAULT_TEST_ENV`; `common` string scalars are flattened first (with `${TEST_ENV.X}`
 * tokens resolved against the selected block), then the selected environment block's, which wins; keys starting
 * with `_` or `$` are documentation and skipped; camelCase keys become SCREAMING_SNAKE_CASE; and an explicitly
 * set environment variable beats the file. If you change how the Playwright side resolves configuration, change
 * it here too — nothing enforces that, which is the price of the second runtime.
 *
 * @example
 * import { requireTargetUrl } from './lib/env.ts';
 * const TARGET = requireTargetUrl(); // aborts at init when nothing is configured
 */
interface EnvConfig {
  common?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
}

/** `open()` resolves relative to THIS file, and it only works in the init context. */
const CONFIG = JSON.parse(open('../../env/environments.json')) as EnvConfig;

/** Matches `${TEST_ENV.SOME_KEY}` inside a `common` value; resolved against the selected environment block. */
const TEST_ENV_TOKEN = /\$\{TEST_ENV\.([A-Za-z0-9_]+)\}/g;

const COMMON = CONFIG.common ?? {};

/** The selected environment: `TEST_ENV` wins, else `common.DEFAULT_TEST_ENV`. */
export const environment: string =
  __ENV.TEST_ENV || (typeof COMMON.DEFAULT_TEST_ENV === 'string' ? COMMON.DEFAULT_TEST_ENV : '');

const BLOCK = CONFIG.environments?.[environment] ?? {};

function toEnvKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function resolveTokens(value: string): string {
  return value.replace(TEST_ENV_TOKEN, (_match: string, key: string) => {
    const resolved = BLOCK[key];
    return typeof resolved === 'string' ? resolved : '';
  });
}

/** Everything the file contributes, flattened the way the Playwright side flattens it into `process.env`. */
const FROM_FILE: Record<string, string> = (() => {
  const flat: Record<string, string> = {};
  const put = (key: string, value: string): void => {
    if (key.startsWith('_') || key.startsWith('$')) {
      return;
    }
    flat[toEnvKey(key)] = value;
  };
  for (const [key, value] of Object.entries(COMMON)) {
    if (typeof value === 'string') {
      put(key, resolveTokens(value));
    }
  }
  // The environment block wins over common — the same order loadEnv applies.
  for (const [key, value] of Object.entries(BLOCK)) {
    if (typeof value === 'string') {
      put(key, value);
    }
  }
  return flat;
})();

/**
 * One configuration value. An explicitly set environment variable wins over the file, including when it is set to
 * an empty string — the same rule `loadEnv` follows, so an exported CI secret is never overwritten by the file.
 */
export function envValue(key: string): string {
  return __ENV[key] !== undefined ? __ENV[key] : (FROM_FILE[key] ?? '');
}

/**
 * The target, or an abort.
 *
 * There is no default and no fallback to `BASE_URL`/`API_BASE_URL` on purpose. Those point at whatever the
 * functional suite happens to use — in a fresh scaffold, public demo services — and a load test that quietly
 * inherits them is how somebody's laptop ends up sending 200 requests a second at a site nobody agreed to.
 * Naming the target is the one decision a load test cannot make for you.
 */
export function requireTargetUrl(): string {
  const url = envValue('PERF_TARGET_URL');
  if (!url) {
    throw new Error(
      'PERF_TARGET_URL is not set, so there is no target to load. Set it per environment in ' +
        'env/environments.json (under environments.<env>, not under common — a load target belongs to one ' +
        'deployment), or pass it for one run: k6 run -e PERF_TARGET_URL=http://localhost:3000/ perf/load.ts. ' +
        'It deliberately does not fall back to BASE_URL or API_BASE_URL.',
    );
  }
  return url;
}
