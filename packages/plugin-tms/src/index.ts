/**
 * `@pwtap/plugin-tms` — test management sync.
 *
 * **No fixture, no Playwright project, no matcher.** Nothing here is imported by a spec: the work
 * happens in a reporter (`@pwtap/plugin-tms/reporter`) and a CLI (`tms`), both outside the test body.
 * That is the same shape `@pwtap/plugin-heal` has, for the same reason — a fixture would put this
 * package on the hot path of every green run to buy nothing.
 *
 * What is exported here is the type surface, for a project that wants to script against the provider
 * directly rather than through the CLI.
 *
 * @example
 * import { readConfig, resolveProvider } from '@pwtap/plugin-tms';
 * const run = await resolveProvider(readConfig()).createRun({ title: 'nightly' });
 */
export {
  gitContext,
  loadEnvFile,
  readConfig,
  runTitle,
  type GitContext,
  type TmsConfig,
  type TmsMode,
} from './config.js';
export type { TmsProbe, TmsProvider, TmsRunInput, TmsRunRef } from './provider.js';
export { KNOWN_PROVIDERS, resolveProvider } from './providers/index.js';
export { QaseApiError } from './providers/qase/client.js';
export { readQaseConfig, type QaseConfig } from './providers/qase/config.js';
