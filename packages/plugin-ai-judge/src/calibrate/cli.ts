#!/usr/bin/env node
import { type CalibrationReport, calibrate } from './calibrate.js';
import { loadDataset, loadProjectEnv } from './dataset.js';

const USAGE = `[ai-judge] judge:calibrate — measure a judge model against human labels

  node …/calibrate/cli.js [dataset.json] [options]

  --model <id>          judge with this model; repeat to compare several (default: auto-routing)
  --min-accuracy <n>    fail when accuracy is below n (0-1 or a percentage)
  --min-kappa <n>       fail when Cohen's kappa is below n
  --max-false-pass <n>  fail when more than n cases passed that a human failed
  --no-cache            re-judge instead of replaying .judge/cache
`;

/** All values given for a repeatable flag. */
function values(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ''] : []));
}

/** A numeric flag, accepting a percentage (90) as well as a fraction (0.9). */
function threshold(argv: string[], flag: string): number | undefined {
  const raw = values(argv, flag)[0];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`[ai-judge] ${flag} needs a number, got '${raw}'`);
  }

  return parsed > 1 ? parsed / 100 : parsed;
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

/** One report, plus the cases where judge and human disagreed — the rows worth reading. */
function print(report: CalibrationReport): void {
  console.info(
    `\n${report.model}: ${pct(report.accuracy)} accuracy (${report.correct}/${report.cases}), ` +
      `kappa ${report.kappa.toFixed(2)}, false pass ${report.falsePass}, false fail ${report.falseFail}`,
  );
  for (const result of report.results.filter(item => item.expected !== item.actual)) {
    const kind = result.actual ? 'FALSE PASS' : 'FALSE FAIL';
    console.info(`  ${kind}  ${result.name} — judged ${result.score}/100: ${result.reasoning}`);
    if (result.unmet.length > 0) {
      console.info(`             unmet: ${result.unmet.join('; ')}`);
    }
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.info(USAGE);
    return 0;
  }

  const file = argv.find(arg => !arg.startsWith('--') && arg.endsWith('.json'));
  if (file === undefined) {
    console.error(`[ai-judge] name a dataset file.\n${USAGE}`);
    return 2;
  }
  if (argv.includes('--no-cache')) {
    process.env.JUDGE_CACHE = 'off';
  }

  loadProjectEnv();
  const cases = loadDataset(file);
  const models = values(argv, '--model');
  const minAccuracy = threshold(argv, '--min-accuracy');
  const minKappa = threshold(argv, '--min-kappa');
  const maxFalsePass = Number(values(argv, '--max-false-pass')[0] ?? NaN);

  console.info(`[ai-judge] ${cases.length} labelled cases from ${file}`);
  const reports: CalibrationReport[] = [];
  for (const model of models.length > 0 ? models : [undefined]) {
    reports.push(
      await calibrate(cases, {
        ...(model === undefined ? {} : { model }),
        onCase: (result, index, total) =>
          process.stdout.write(
            `  [${index + 1}/${total}] ${result.expected === result.actual ? 'ok  ' : 'MISS'} ${result.name} (${result.score}/100)\n`,
          ),
      }),
    );
    print(reports[reports.length - 1]);
  }

  // Gates are per model: a fleet comparison should fail if any candidate is below the bar.
  const failures = reports.flatMap(report => [
    ...(minAccuracy !== undefined && report.accuracy < minAccuracy
      ? [`${report.model}: accuracy ${pct(report.accuracy)} < ${pct(minAccuracy)}`]
      : []),
    ...(minKappa !== undefined && report.kappa < minKappa
      ? [`${report.model}: kappa ${report.kappa.toFixed(2)} < ${minKappa}`]
      : []),
    ...(Number.isFinite(maxFalsePass) && report.falsePass > maxFalsePass
      ? [`${report.model}: ${report.falsePass} false passes > ${maxFalsePass}`]
      : []),
  ]);

  if (failures.length > 0) {
    console.error(`\n[ai-judge] calibration gate failed:\n  ${failures.join('\n  ')}`);
    return 1;
  }
  console.info('\n[ai-judge] calibration OK');

  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 2;
});
