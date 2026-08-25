/**
 * Qase's half of the configuration. Kept out of `src/config.ts` so the neutral core never learns a
 * `QASE_` key — the whole point of the provider split.
 *
 * The key names are **Qase's own** (`QASE_TESTOPS_*`), not ours. `playwright-qase-reporter` already reads
 * them, teams already have them in CI secrets, and inventing `TMS_QASE_TOKEN` next to an identical
 * variable the vendor's tooling reads would be a second name for one fact.
 *
 * @example
 * // env/environments.json → common: { "QASE_TESTOPS_PROJECT": "DEMO", "QASE_TESTOPS_API_TOKEN": "" }
 * // …with the token itself exported by CI, never committed.
 */

export interface QaseConfig {
  token: string;
  project: string;
  /** `https://api.qase.io/v1` unless `QASE_API_BASE_URL` says otherwise (self-hosted, or a test double). */
  baseUrl: string;
  /** Set by CI so every shard writes into one run. Empty means "create one". */
  runId: string;
}

export const QASE_DEFAULT_BASE_URL = 'https://api.qase.io/v1';

export function readQaseConfig(env: NodeJS.ProcessEnv = process.env): QaseConfig {
  const trimmed = (key: string): string => env[key]?.trim() ?? '';
  const baseUrl = trimmed('QASE_API_BASE_URL');
  return {
    token: trimmed('QASE_TESTOPS_API_TOKEN'),
    project: trimmed('QASE_TESTOPS_PROJECT').toUpperCase(),
    baseUrl: (baseUrl === '' ? QASE_DEFAULT_BASE_URL : baseUrl).replace(/\/+$/, ''),
    runId: trimmed('QASE_TESTOPS_RUN_ID'),
  };
}

/**
 * The missing pieces, by name, or an empty list. Returned rather than thrown so `tms doctor` can print
 * every problem at once instead of the first one — a user with neither a token nor a project code should
 * learn both facts in one run.
 */
export function missingQaseConfig(config: QaseConfig): string[] {
  const missing: string[] = [];
  if (config.token === '') {
    missing.push('QASE_TESTOPS_API_TOKEN');
  }
  if (config.project === '') {
    missing.push('QASE_TESTOPS_PROJECT');
  }
  return missing;
}
