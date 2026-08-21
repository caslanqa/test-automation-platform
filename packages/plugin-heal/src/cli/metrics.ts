/**
 * `heal metrics` and `heal revert` — was the healing any good, and the one way to say it was not.
 *
 * The report prints the three mask detectors **separately** and labels two of them heuristics, because
 * a reader who mistakes "somebody edited that line afterwards" for "this heal hid a bug" will either
 * panic or, worse, learn to ignore the number. The one that is ground truth is the one a human typed:
 * `heal revert <id> --reason masked-bug`.
 *
 * `heal revert` records; it does not edit code. Undoing the edit is `git revert`, which is better at it
 * and already understood — what git cannot do is tell the metrics *why* it was undone.
 *
 * @example
 * heal metrics --json heal-metrics.json
 * heal revert 9f2c1a --reason masked-bug --note "the button was disabled, not moved"
 */
import fs from 'node:fs';
import path from 'node:path';

import { BASELINE_PATH, foldBaseline, loadBaseline, saveBaseline } from '../history/baseline.js';
import { readRuns, RUNS_DIR } from '../history/runStore.js';
import { appendRevert, readHealLog, type RevertReason } from '../metrics/healLog.js';
import { healMetrics, MIN_APPLIED_FOR_PRECISION } from '../metrics/healMetrics.js';
import { healsRemoved } from '../metrics/rewritten.js';
import { loadQuarantine } from '../quarantine/file.js';
import { flagNumber, flagPresent, flagValue, positionals } from './args.js';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const percent = (value: number | undefined): string =>
  value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;

const REASONS = new Set<RevertReason>(['masked-bug', 'wrong-element', 'no-longer-needed']);

export function commandMetrics(projectDir: string, argv: string[]): number {
  const runsDir = path.resolve(projectDir, flagValue(argv, '--runs-dir') ?? RUNS_DIR);
  const runs = readRuns(runsDir);
  const log = readHealLog(projectDir);
  const quarantine = loadQuarantine(projectDir);
  if (quarantine.problem !== undefined) {
    err(`[heal] ${quarantine.problem}`);
  }

  const report = healMetrics({
    heals: log.entries,
    runs,
    quarantine: quarantine.file.entries,
    now: Date.now(),
    survivalRuns: flagNumber(argv, '--survival-runs', undefined),
    unreadableLogLines: log.unreadable,
    removed: healsRemoved(projectDir, log.entries),
    trendWindow: flagNumber(argv, '--trend-window', undefined),
  });

  out(`[heal] ${report.applied} heal(s) applied, over ${runs.length} recorded run(s).`);
  if (report.applied === 0) {
    out('       Nothing has been healed yet, so precision and mask rate have no input.');
  } else {
    out(
      `       survived ${report.survived}  ·  regressed ${report.regressed}  ·  precision ${
        report.precision === undefined
          ? `n/a (needs ${MIN_APPLIED_FOR_PRECISION} applied heals — a single unlucky one must not decide this)`
          : percent(report.precision)
      }`,
    );
    out(`       mask rate ${percent(report.maskRate)} — the number that matters, gated at zero.`);
  }
  if (report.recall !== undefined) {
    out(
      `       recall ${percent(report.recall)} of ${report.eligible} drift-shaped failure(s) — reported, never gated: the denominator is our own classifier.`,
    );
  }
  if (report.medianTimeToHealHours !== undefined) {
    out(`       median time to heal ${report.medianTimeToHealHours.toFixed(1)}h`);
  }
  if (report.flakeRateTrend !== undefined) {
    const trend = report.flakeRateTrend;
    const direction = trend.delta > 0 ? 'worse' : trend.delta < 0 ? 'better' : 'flat';
    out(
      `       flake rate ${percent(trend.recent)} vs ${percent(trend.previous)} before it — ${direction}. A healer whose precision climbs while this does too is treating symptoms.`,
    );
  }

  if (report.masked.length > 0) {
    out('');
    out(`[heal] ${report.masked.length} heal(s) may have hidden something:`);
    for (const masked of report.masked) {
      out(`  ✗ ${masked.title}`);
      out(`      ${masked.file}:${masked.line}`);
      for (const detector of masked.detectors) {
        const kind = detector === 'reverted-as-masking' ? 'GROUND TRUTH' : 'heuristic';
        out(`      · ${detector} (${kind})`);
      }
    }
    out('');
    out(
      '[heal] A heuristic is not a finding. Read each one, then record what it was: heal revert <healId> --reason masked-bug|wrong-element|no-longer-needed',
    );
  }

  const shape = report.quarantine;
  out('');
  out(
    `[heal] quarantine: ${shape.size} entr(ies), oldest ${shape.oldestAgeDays} day(s), ${shape.expired} expired, ${shape.netAdded7d} added in the last 7 days.`,
  );
  if (report.unreadableLogLines > 0) {
    err(
      `[heal] ${report.unreadableLogLines} line(s) of heal/heal-log.jsonl could not be read — these numbers are computed without them.`,
    );
  }

  const jsonPath = flagValue(argv, '--json');
  if (jsonPath !== undefined) {
    const target = path.resolve(projectDir, jsonPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    out(`[heal] wrote ${path.relative(projectDir, target)}`);
  }

  // The mask gate is the only one here with teeth, and it is zero by default: one masked bug costs
  // more than every heal ever saved.
  const maxMasked = flagNumber(argv, '--max-masked', 0) ?? 0;
  if (report.masked.length > maxMasked) {
    err(
      `[heal] gate 'mask-rate': ${report.masked.length} suspected mask(s) > ${maxMasked}. Review each and record the verdict with 'heal revert'.`,
    );
    return 1;
  }
  return 0;
}

export function commandRevert(projectDir: string, argv: string[]): number {
  const [healId] = positionals(argv);
  const reason = flagValue(argv, '--reason');
  if (healId === undefined || reason === undefined) {
    err(
      "[heal] usage: heal revert <healId> --reason masked-bug|wrong-element|no-longer-needed [--note '…']",
    );
    return 2;
  }
  if (!REASONS.has(reason as RevertReason)) {
    err(`[heal] revert: '${reason}' is not a reason. Use ${[...REASONS].join(', ')}.`);
    return 2;
  }

  const entry = appendRevert(projectDir, healId, reason as RevertReason, flagValue(argv, '--note'));
  if (entry === undefined) {
    err(`[heal] no un-reverted heal with id '${healId}' in heal/heal-log.jsonl.`);
    return 1;
  }
  out(`[heal] recorded: ${healId} reverted as '${reason}'.`);
  out(`       ${entry.file}:${entry.line}  ${entry.from}  →  ${entry.to}`);
  if (reason !== 'no-longer-needed') {
    out('       This counts against the mask rate, which is gated at zero. That is the point.');
  }
  out(
    '[heal] The log records what happened; it does not touch the code. Undo the edit with git if it is still in place.',
  );
  return 0;
}

/**
 * `heal baseline --update` — fold the recorded runs into the committed rolling aggregate.
 *
 * The nightly job runs this and opens a pull request with the result. It is additive and idempotent:
 * runs already folded in are skipped by id, so re-running it, or running it on two machines that each
 * saw part of the history, adds each run exactly once.
 *
 * Without `--update` it only reports, which is what a human wants before committing a counter change.
 */
export function commandBaseline(projectDir: string, argv: string[]): number {
  const runsDir = path.resolve(projectDir, flagValue(argv, '--runs-dir') ?? RUNS_DIR);
  const runs = readRuns(runsDir);
  const file = flagValue(argv, '--baseline') ?? BASELINE_PATH;
  const loaded = loadBaseline(projectDir, file);
  if (loaded.problem !== undefined) {
    err(`[heal] ${loaded.problem}`);
  }

  const folded = foldBaseline(runs, loaded.baseline, {
    window: flagNumber(argv, '--window', undefined),
  });
  const before = loaded.baseline.entries.length;
  const after = folded.baseline.entries.length;

  if (folded.foldedRuns === 0) {
    out(
      `[heal] nothing to fold — all ${runs.length} recorded run(s) are already in ${file}, which tracks ${before} test(s).`,
    );
    return 0;
  }

  const flaky = folded.baseline.entries.filter(
    entry => entry.runs > 0 && (entry.fails + entry.passOnRetry) / entry.runs >= 0.2,
  );
  out(
    `[heal] folded ${folded.foldedRuns} new run(s) into ${file}: ${after} test(s) tracked (${after - before} new).`,
  );
  if (flaky.length > 0) {
    out(`[heal] ${flaky.length} test(s) at or above a 20% flake rate:`);
    for (const entry of flaky.slice(0, 10)) {
      const rate = ((entry.fails + entry.passOnRetry) / entry.runs) * 100;
      out(`  ${rate.toFixed(0).padStart(3)}%  ${entry.runs} run(s)  ${entry.title}`);
    }
  }

  if (!flagPresent(argv, '--update')) {
    out('[heal] nothing written. Re-run with --update to commit the new counters.');
    return 0;
  }
  saveBaseline(projectDir, folded.baseline, file);
  out(
    `[heal] wrote ${file}. Commit it — this file is what makes flake history outlive an artifact.`,
  );
  return 0;
}
