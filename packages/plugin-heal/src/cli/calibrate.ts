/**
 * `heal calibrate` — grade the classifier against human labels, and gate on the result.
 *
 * Deliberately the same shape as `plugin-ai-judge`'s calibration CLI, including the ordering detail
 * that looks like an accident and is not: **the JSON report is written before the gates are applied.**
 * The run that breached a gate is the run whose numbers get compared against last night's, so failing
 * before writing them would throw away the only evidence anyone wants.
 *
 * It is offline. No browser, no model, no network, no run of the suite — because a gate that needs the
 * world to be reachable is a gate that gets disabled.
 *
 * @example
 * heal calibrate --json heal-calibration.json --min-kappa 0.7
 * heal calibrate --harvest            # draft cases from real runs, for a human to correct
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  calibrateTriage,
  GATE_DEFAULTS,
  gateCalibration,
  type CalibrationReport,
} from '../calibrate/calibrate.js';
import { CASES_PATH, loadCases, saveCases } from '../calibrate/dataset.js';
import { harvestCases } from '../calibrate/harvest.js';
import { readRuns, RUNS_DIR } from '../history/runStore.js';
import { flagNumber, flagPresent, flagValue } from './args.js';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Landis-Koch, so a number becomes a sentence. */
function kappaWord(kappa: number): string {
  if (kappa < 0) return 'worse than chance';
  if (kappa < 0.21) return 'slight';
  if (kappa < 0.41) return 'fair';
  if (kappa < 0.61) return 'moderate';
  if (kappa < 0.81) return 'substantial';
  return 'almost perfect';
}

function printReport(report: CalibrationReport): void {
  out(
    `[heal] ${report.correct}/${report.cases} correct — accuracy ${(report.accuracy * 100).toFixed(1)}%`,
  );
  out(
    `       kappa ${report.kappa.toFixed(3)} (${kappaWord(report.kappa)}) — the gate that actually protects.`,
  );
  out(
    `       false heals ${report.falseHeal}  ·  false bugs ${report.falseBug}  ·  lost vetoes ${report.missingVeto}`,
  );
  out('');
  out('       class            expected  classified  correct');
  for (const row of report.confusion) {
    out(
      `       ${row.klass.padEnd(16)}${String(row.expected).padStart(8)}${String(row.actual).padStart(12)}${String(row.correct).padStart(9)}`,
    );
  }

  const wrong = report.results.filter(result => !result.correct || result.missingVetoes.length > 0);
  if (wrong.length > 0) {
    out('');
    out(`[heal] ${wrong.length} case(s) to look at:`);
    for (const result of wrong) {
      if (!result.correct) {
        out(
          `  ✗ expected ${result.expected}, got ${result.actual} (${result.confidence})  ${result.name}`,
        );
      } else {
        out(`  ✗ class ok, veto lost: ${result.missingVetoes.join(', ')}  ${result.name}`);
      }
      for (const reason of result.reasons) {
        out(`      · ${reason}`);
      }
      if (result.note !== undefined) {
        out(`      note: ${result.note}`);
      }
    }
  }
}

function commandHarvest(projectDir: string, argv: string[]): number {
  const runsDir = path.resolve(projectDir, flagValue(argv, '--runs-dir') ?? RUNS_DIR);
  const runs = readRuns(runsDir);
  if (runs.length === 0) {
    err('[heal] no run records to harvest from — run the suite with the heal reporter first.');
    return 1;
  }
  const file = flagValue(argv, '--cases') ?? CASES_PATH;
  const existing = loadCases(projectDir, file).cases;
  const known = new Set(
    existing.map(entry => entry.source).filter((source): source is string => source !== undefined),
  );

  const drafted = harvestCases(runs, { limit: flagNumber(argv, '--limit', 20) });
  const fresh = drafted.filter(entry => !known.has(entry.source ?? ''));
  if (fresh.length === 0) {
    out(
      '[heal] nothing new to draft — every failure in the recorded runs is already in the dataset.',
    );
    return 0;
  }

  saveCases(projectDir, [...existing, ...fresh], file);
  out(
    `[heal] drafted ${fresh.length} case(s) into ${file} (${existing.length + fresh.length} total).`,
  );
  out(
    "[heal] Each one's `expected` is the classifier's own answer. Review and correct them — a case that agrees by construction grades nothing.",
  );
  return 0;
}

export function commandCalibrate(projectDir: string, argv: string[]): number {
  if (flagPresent(argv, '--harvest')) {
    return commandHarvest(projectDir, argv);
  }

  const file = flagValue(argv, '--cases') ?? CASES_PATH;
  const loaded = loadCases(projectDir, file);
  if (loaded.problem !== undefined) {
    err(`[heal] ${loaded.problem}`);
  }
  if (loaded.cases.length === 0) {
    return 1;
  }

  const report = calibrateTriage(loaded.cases);
  printReport(report);

  // Written BEFORE the gates: the run that breached one is the run whose numbers get compared
  // against last night's.
  const jsonPath = flagValue(argv, '--json');
  if (jsonPath !== undefined) {
    const target = path.resolve(projectDir, jsonPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    out('');
    out(`[heal] wrote ${path.relative(projectDir, target)}`);
  }

  // Accuracy is given as a percentage on the command line, matching the judge's `--min-accuracy 90`,
  // and stored as a fraction. Mixing the two is the kind of mistake that reads as a passing gate.
  const accuracyPercent =
    flagNumber(argv, '--min-accuracy', GATE_DEFAULTS.minAccuracy * 100) ??
    GATE_DEFAULTS.minAccuracy * 100;

  const failures = gateCalibration(report, {
    minAccuracy: accuracyPercent / 100,
    minKappa: flagNumber(argv, '--min-kappa', GATE_DEFAULTS.minKappa),
    maxFalseHeal: flagNumber(argv, '--max-false-heal', GATE_DEFAULTS.maxFalseHeal),
    maxMissingVeto: flagNumber(argv, '--max-missing-veto', GATE_DEFAULTS.maxMissingVeto),
  });
  if (failures.length > 0) {
    out('');
    for (const failure of failures) {
      err(`[heal] gate failed: ${failure}`);
    }
    return 1;
  }
  out('');
  out('[heal] calibration ok.');
  return 0;
}
