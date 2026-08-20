/**
 * `@pwtap/plugin-heal` — failure triage, flake detection and quarantine for a Playwright suite.
 *
 * The public surface is deliberately narrow: the types a consumer might read out of a run record,
 * and the pure functions a consumer might want to reuse. The reporter is a separate entry point
 * (`@pwtap/plugin-heal/reporter`) because the config names it as a string, and the CLI is a `bin`.
 *
 * Everything here is deterministic and works with no model, no network and no browser. That is the
 * point: an LLM tier is an optional escalation for the `unknown` class, not a requirement, and CI
 * must be able to reach a verdict without one.
 *
 * @example
 * import { readRuns, flakeStats } from '@pwtap/plugin-heal';
 * const runs = readRuns('.heal/runs');
 * flakeStats(runs, someTestKey).flakeRate;
 */
export {
  RUN_SCHEMA,
  TAXONOMY_VERSION,
  type AttemptRecord,
  type Baseline,
  type BaselineEntry,
  type ErrorKind,
  type FailureRecord,
  type RunRecord,
  type TestRecord,
} from './types.js';

export { flakeStats, type FlakeStats, type FlakeStatsOptions } from './history/flakeStats.js';
export {
  DEFAULT_KEEP,
  RUNS_DIR,
  pruneRuns,
  readRuns,
  runFileName,
  stampFor,
  writeRun,
  type ReadRunsOptions,
} from './history/runStore.js';
export { testKey, titlePathAfterFile } from './history/testKey.js';

export { callLogLines, displayMessage, normalizeMessage, stripAnsi } from './triage/ansi.js';
export {
  band,
  classify,
  type Triage,
  type TriageClass,
  type TriageInput,
} from './triage/classify.js';
export { changedFiles, touched, type ChangedFiles } from './triage/gitDiff.js';
export { lastFailure, triageRun, type Finding, type TriageRunOptions } from './triage/run.js';

export {
  LANDMARK_ROLES,
  flatten,
  landmarkPath,
  parseAriaSnapshot,
  snapshotFromErrorContext,
  type AriaNode,
} from './heal/ariaSnapshot.js';
export {
  normalizeName,
  targetsFor,
  webLocatorCandidates,
  type CandidateStrategy,
  type HealCandidate,
} from './heal/candidates.js';
export {
  MIN_CANDIDATE_SCORE,
  eligibleForAutofix,
  proveEquivalence,
  type Equivalence,
  type EquivalenceVerdict,
} from './heal/equivalence.js';
export { parseLocatorIntent, type LocatorIntent } from './heal/intent.js';
export {
  PROPOSALS_DIR,
  planEdit,
  unifiedDiff,
  writeProposal,
  type CodeEdit,
  type Proposal,
} from './heal/patch.js';
export { proposeForFinding, type ProposeOptions, type ProposeOutcome } from './heal/propose.js';
export {
  DEFAULT_GREENS,
  escapeTitle,
  verifyCandidate,
  verifyReporterPath,
  type RerunResult,
} from './heal/rerun.js';
export { VERIFY_PREFIX, parseVerifyOutput, type VerifyLine } from './heal/verifyReporter.js';
export { classifyError, type ClassifyErrorInput, type ErrorFacts } from './triage/errorTaxonomy.js';
export {
  errorFingerprint,
  siteFingerprint,
  type ErrorInput,
  type SiteInput,
} from './triage/fingerprint.js';

export {
  EMPTY_QUARANTINE,
  QUARANTINE_PATH,
  loadQuarantine,
  saveQuarantine,
  type QuarantineClass,
  type QuarantineEntry,
  type QuarantineFile,
} from './quarantine/file.js';
export {
  gateQuarantine,
  type GateOptions,
  type GateResult,
  type GateViolation,
} from './quarantine/gate.js';
export {
  daysLeft,
  decideShield,
  isExpired,
  isShielded,
  type ShieldDecision,
} from './quarantine/shield.js';
