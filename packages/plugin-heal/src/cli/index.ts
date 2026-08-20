/**
 * `heal` — the CLI. Deterministic, offline, and the whole contract CI needs.
 *
 * ```
 * heal triage    [--json <path>] [--runs-dir <dir>] [--window N]
 * heal gate      [--max-quarantine N] [--total-tests N] [--no-ratchet]
 * heal quarantine list
 * ```
 *
 * Nothing here calls a model, opens a browser, or writes to a test file. An agent front end is a
 * nicer way to read this output, never a way to reach a verdict the CLI cannot — if the engine needed
 * an agent to decide, the decision would not be trustworthy in CI, which is where it matters most.
 *
 * Exit codes: 0 ok · 1 a gate failed or a triage found an unshielded failure · 2 usage.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { flakeStats } from '../history/flakeStats.js';
import { readRuns, RUNS_DIR } from '../history/runStore.js';
import { loadQuarantine, type QuarantineEntry } from '../quarantine/file.js';
import { gateQuarantine } from '../quarantine/gate.js';
import { daysLeft, decideShield, isExpired } from '../quarantine/shield.js';
import { band, classify, type Triage } from '../triage/classify.js';
import { changedFiles, touched } from '../triage/gitDiff.js';
import type { RunRecord, TestRecord } from '../types.js';
import { flagNumber, flagPresent, flagValue, positionals } from './args.js';

const USAGE = `heal — failure triage, flake detection and quarantine

  heal triage [--json <path>] [--runs-dir <dir>] [--window N]
      Classify every failure in the most recent run: flaky / locator-drift / true-fail / env-infra.

  heal gate [--max-quarantine N] [--total-tests N] [--no-ratchet] [--runs-dir <dir>]
      CI gate. Exits 1 on a quarantine violation or an unshielded failure.

  heal quarantine list
      What is quarantined, and for how much longer.
`;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

interface Finding {
  test: TestRecord;
  triage: Triage;
}

function latestRun(runsDir: string): RunRecord | undefined {
  return readRuns(runsDir, { limit: 1 })[0];
}

/** Classify every unexpected or flaky test in `run`, using the rest of the runs as history. */
function triageRun(
  projectDir: string,
  run: RunRecord,
  runs: RunRecord[],
  window: number,
): Finding[] {
  const changed = changedFiles(projectDir, run.baseRef);
  const findings: Finding[] = [];

  for (const test of run.tests) {
    if (test.outcome !== 'unexpected' && test.outcome !== 'flaky') {
      continue;
    }
    // The last attempt that actually failed is the one whose evidence describes the failure.
    const failure = [...test.attempts].reverse().find(attempt => attempt.failure)?.failure;
    const history = flakeStats(
      runs.filter(candidate => candidate.runId !== run.runId),
      test.testKey,
      { window },
    );
    findings.push({
      test,
      triage: classify({
        outcome: test.outcome,
        failure,
        history: history.runs === 0 ? undefined : history,
        hadGlobalErrors: run.globalErrors.length > 0,
        diffUnknown: !changed.known,
        testFileChanged: changed.known ? touched(changed, test.file) : undefined,
        topFrameFileChanged: changed.known ? touched(changed, failure?.topFrame?.file) : undefined,
        infraFileChanged: changed.known
          ? touched(changed, 'package-lock.json') || touched(changed, 'playwright.config.ts')
          : undefined,
        configRetries: run.configRetries,
      }),
    });
  }
  return findings;
}

const ICON: Record<string, string> = {
  flaky: '~',
  'locator-drift': '→',
  'true-fail': '✗',
  'env-infra': '⚙',
  unknown: '?',
};

function printFindings(findings: Finding[], run: RunRecord): void {
  if (findings.length === 0) {
    out(`[heal] ${run.tests.length} tests, nothing to triage — no failures in the last run.`);
    return;
  }
  out(`[heal] ${findings.length} failure(s) in the run started ${run.startedAt}:`);
  out('');
  for (const { test, triage } of findings) {
    const title = test.titlePath.join(' › ');
    const project = test.project === '' ? '' : `[${test.project}] `;
    out(
      `  ${ICON[triage.class] ?? '?'} ${triage.class}  (${triage.confidence}, ${band(triage.confidence)})  ${project}${title}`,
    );
    out(`      ${test.file}:${test.line}`);
    for (const reason of triage.reasons) {
      out(`      · ${reason}`);
    }
    if (triage.vetoes.length > 0) {
      out(`      no autofix: ${triage.vetoes.join('; ')}`);
    }
    out('');
  }
  const trueFails = findings.filter(finding => finding.triage.class === 'true-fail');
  if (trueFails.length > 0) {
    out(
      `[heal] ${trueFails.length} of these look like real regressions. Do not change the expected values — report them.`,
    );
  }
}

function commandTriage(projectDir: string, argv: string[]): number {
  const runsDir = path.resolve(projectDir, flagValue(argv, '--runs-dir') ?? RUNS_DIR);
  const runs = readRuns(runsDir);
  const run = runs[0];
  if (run === undefined) {
    err(
      `[heal] no run records in ${path.relative(projectDir, runsDir) || runsDir}. Run the suite once with the heal reporter configured.`,
    );
    return 1;
  }
  const findings = triageRun(projectDir, run, runs, flagNumber(argv, '--window', 20) ?? 20);
  printFindings(findings, run);

  const jsonPath = flagValue(argv, '--json');
  if (jsonPath !== undefined) {
    const target = path.resolve(projectDir, jsonPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify(
        {
          runId: run.runId,
          startedAt: run.startedAt,
          commit: run.commit,
          findings: findings.map(({ test, triage }) => ({
            testKey: test.testKey,
            project: test.project,
            file: test.file,
            line: test.line,
            title: test.titlePath.join(' › '),
            outcome: test.outcome,
            class: triage.class,
            confidence: triage.confidence,
            band: band(triage.confidence),
            reasons: triage.reasons,
            vetoes: triage.vetoes,
            scores: triage.scores,
          })),
        },
        null,
        2,
      )}\n`,
    );
    out(`[heal] wrote ${path.relative(projectDir, target)}`);
  }
  // Triage reports; it does not gate. `heal gate` is what CI keys on.
  return 0;
}

/** The list as of the previous commit, for the ratchet. Undefined when git cannot say. */
function previousQuarantine(projectDir: string): QuarantineEntry[] | undefined {
  try {
    const raw = execFileSync('git', ['show', 'HEAD~1:heal/quarantine.json'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw) as { entries?: QuarantineEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : undefined;
  } catch {
    return undefined;
  }
}

function commandGate(projectDir: string, argv: string[]): number {
  const loaded = loadQuarantine(projectDir);
  if (loaded.problem !== undefined) {
    err(`[heal] ${loaded.problem}`);
  }
  const entries = loaded.file.entries;
  const now = Date.now();

  const result = gateQuarantine({
    entries,
    now,
    totalTests: flagNumber(argv, '--total-tests', undefined),
    previous: flagPresent(argv, '--no-ratchet') ? undefined : previousQuarantine(projectDir),
    maxEntries: flagNumber(argv, '--max-quarantine', undefined),
    maxTtlDays: flagNumber(argv, '--max-ttl-days', undefined),
  });

  let failed = !result.ok;
  for (const violation of result.violations) {
    err(`[heal] gate '${violation.gate}': ${violation.message}`);
    for (const name of violation.entries) {
      err(`         - ${name}`);
    }
  }

  // The second half of the gate: a failing run whose failures are not all quarantined.
  const runsDir = path.resolve(projectDir, flagValue(argv, '--runs-dir') ?? RUNS_DIR);
  const run = latestRun(runsDir);
  if (run !== undefined) {
    const failedKeys = run.tests
      .filter(test => test.outcome === 'unexpected')
      .map(test => test.testKey);
    const decision = decideShield(failedKeys, entries, now);
    if (decision.unshielded.length > 0) {
      const titles = run.tests
        .filter(test => decision.unshielded.includes(test.testKey))
        .map(test => `${test.file} › ${test.titlePath.join(' › ')}`);
      err(`[heal] ${decision.unshielded.length} failure(s) in the last run are not quarantined:`);
      for (const title of titles) {
        err(`         - ${title}`);
      }
      failed = true;
    }
  }

  if (!failed) {
    out(
      `[heal] gate ok — ${entries.length} quarantined, ${result.quarantineDays} quarantine-day(s) committed, oldest ${result.oldestAgeDays} day(s).`,
    );
  }
  return failed ? 1 : 0;
}

function commandQuarantine(projectDir: string, argv: string[]): number {
  const [sub = 'list'] = positionals(argv);
  if (sub !== 'list') {
    err(`[heal] quarantine: unknown subcommand '${sub}'. Only 'list' exists so far.`);
    return 2;
  }
  const loaded = loadQuarantine(projectDir);
  if (loaded.problem !== undefined) {
    err(`[heal] ${loaded.problem}`);
  }
  const entries = loaded.file.entries;
  if (entries.length === 0) {
    out('[heal] nothing is quarantined.');
    return 0;
  }
  const now = Date.now();
  out(`[heal] ${entries.length} quarantined test(s):`);
  for (const entry of entries) {
    const left = daysLeft(entry, now);
    const state = isExpired(entry, now) ? 'EXPIRED' : `${left} day(s) left`;
    const issue = entry.issue ?? 'NO ISSUE';
    out(`  ${entry.class.padEnd(9)} ${state.padEnd(16)} ${issue.padEnd(24)} ${entry.title}`);
    out(`      ${entry.file}  — ${entry.reason}`);
  }
  return 0;
}

export function run(argv: string[], projectDir = process.cwd()): number {
  const [command] = positionals(argv);
  switch (command) {
    case 'triage':
      return commandTriage(projectDir, argv);
    case 'gate':
      return commandGate(projectDir, argv);
    case 'quarantine':
      return commandQuarantine(projectDir, argv.slice(argv.indexOf('quarantine') + 1));
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return command === undefined ? 2 : 0;
    default:
      err(`[heal] unknown command '${command}'\n`);
      err(USAGE);
      return 2;
  }
}
