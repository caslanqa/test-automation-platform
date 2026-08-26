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
export {
  DEFECT_CLASS,
  defectBody,
  defectTitle,
  planDefects,
  type DefectPlan,
} from './defects/plan.js';
export {
  DEFAULT_QUARANTINE_FILE,
  DEFAULT_TRIAGE_FILE,
  readQuarantine,
  readTriage,
  type TriageFinding,
  type TriageReport,
} from './heal/read.js';
export type {
  NewTmsCase,
  TmsCase,
  TmsCasePatch,
  TmsProbe,
  TmsProvider,
  TmsRunInput,
  TmsRunRef,
} from './provider.js';
export { KNOWN_PROVIDERS, resolveProvider } from './providers/index.js';
export { QaseApiError } from './providers/qase/client.js';
export { readQaseConfig, type QaseConfig } from './providers/qase/config.js';
export { gateMatrix, type GateFinding, type GateVerdict } from './requirements/gate.js';
export {
  REQUIREMENTS_DIR,
  loadRequirements,
  type AcceptanceCriterion,
  type Requirement,
  type RequirementSet,
} from './requirements/load.js';
export {
  buildMatrix,
  countByVerdict,
  renderCsv,
  renderJson,
  renderMarkdown,
  splitReference,
  type Matrix,
  type MatrixRow,
  type Verdict,
} from './requirements/rtm.js';
export { insertQaseId, type AnnotateResult } from './sync/annotate.js';
export { applySync, type ApplyResult } from './sync/apply.js';
export { planIsEmpty, planSync, type SyncPlan } from './sync/diff.js';
export {
  QASE_ID_ANNOTATION,
  REQUIREMENT_ANNOTATION,
  discoverTests,
  healTitle,
  readResultsReport,
  sameFile,
  testKey,
  type DiscoveredTest,
  type Discovery,
} from './sync/discover.js';
export { renderPlan } from './sync/report.js';
