import fs from 'fs';
import path from 'path';

import type { CalibrationCase } from './calibrate.js';

/** Environment file a scaffolded project keeps its JUDGE_* keys in. */
const ENV_FILE = path.join('env', 'environments.json');

/**
 * Read labelled cases from a JSON file — either `{ "cases": [...] }` or a bare array. A case's `image`
 * is resolved against the dataset's own directory, so a dataset can sit next to its screenshots.
 * @example loadDataset('tests/ai-judge/calibration.json');
 */
export function loadDataset(file: string): CalibrationCase[] {
  const absolute = path.resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(
      `[ai-judge] could not read the calibration dataset at ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const cases = Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown }).cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(
      `[ai-judge] ${absolute} holds no cases — expected { "cases": [ { "input": {…}, "expected": "pass" } ] }.`,
    );
  }

  const dir = path.dirname(absolute);

  return cases.map((entry, index) => {
    const item = entry as CalibrationCase;
    if (item?.input === undefined || item.expected === undefined) {
      throw new Error(
        `[ai-judge] case ${index + 1} in ${absolute} needs both 'input' and 'expected'.`,
      );
    }
    const image = item.input.image;

    return typeof image === 'string' && !path.isAbsolute(image)
      ? { ...item, input: { ...item.input, image: path.resolve(dir, image) } }
      : item;
  });
}

/**
 * The dataset to grade: the LAST `.json` argument wins. The npm script carries the default path, and
 * `npm run judge:calibrate -- mine.json` appends the user's after it — taking the first match graded the
 * default file and said nothing about it.
 * @example pickDataset(['tests/ai-judge/calibration.json', 'mine.json']); // 'mine.json'
 */
export function pickDataset(argv: string[], exclude?: string): string | undefined {
  const matches = argv.filter(
    arg => !arg.startsWith('--') && arg.endsWith('.json') && arg !== exclude,
  );

  return matches[matches.length - 1];
}

/** Resolve `${TEST_ENV.KEY}` against the selected environment block, the way the project's loader does. */
function resolveRef(value: string, selected: Record<string, unknown>): string {
  return value.replace(/\$\{TEST_ENV\.([^}]+)\}/g, (_, key: string) => {
    const target = selected[key];
    return typeof target === 'string' ? target : '';
  });
}

/**
 * Flatten a scaffolded project's `env/environments.json` into `process.env` so the CLI reaches the same
 * JUDGE_* keys the test run does. Already-set variables win, which is what makes
 * `JUDGE_MODEL=… npm run judge:calibrate` work. Missing file: nothing happens.
 * @example loadProjectEnv(process.cwd());
 */
export function loadProjectEnv(root = process.cwd()): void {
  const file = path.join(root, ENV_FILE);
  if (!fs.existsSync(file)) {
    return;
  }

  let config: { common?: Record<string, unknown>; environments?: Record<string, unknown> };
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return; // an unreadable env file is the test run's problem to report, not the calibrator's
  }

  const common = config.common ?? {};
  const envName = process.env.TEST_ENV ?? (common.DEFAULT_TEST_ENV as string) ?? '';
  const selected = (config.environments?.[envName] ?? {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries({ ...common, ...selected })) {
    if (typeof value === 'string' && value.length > 0 && process.env[key] === undefined) {
      process.env[key] = resolveRef(value, selected);
    }
  }
}
