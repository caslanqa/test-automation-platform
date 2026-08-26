/**
 * Rendering a plan for a human.
 *
 * `--dry-run` is the default, so this output *is* the product for most invocations. Two rules it
 * follows:
 *
 * - **Counts before detail.** Someone syncing 400 tests wants the six numbers, then the exceptions.
 * - **No silent truncation.** A capped list says how many it dropped. A report that quietly shows the
 *   first ten of ninety reads as "there were ten", which is how a sync surprises someone at `--apply`.
 *
 * @example
 * for (const line of renderPlan(plan, { existingCount: 98, limit: 10 })) out(line);
 */
import type { SyncPlan } from './diff.js';
import type { DiscoveredTest } from './discover.js';

export interface RenderOptions {
  /** How many cases the tool already held, for the header. */
  existingCount: number;
  /** How many detail lines per section. */
  limit?: number;
  /** True once the plan has been executed, so the wording is past tense. */
  applied?: boolean;
}

const DEFAULT_LIMIT = 10;

const where = (test: DiscoveredTest): string => `${test.file}:${test.line}`;
const name = (test: DiscoveredTest): string => [...test.suitePath, test.title].join(' › ');

function section(
  out: string[],
  label: string,
  rows: readonly string[],
  limit: number,
  note?: string,
): void {
  if (rows.length === 0) {
    return;
  }
  out.push('');
  out.push(`${label} (${rows.length})${note === undefined ? '' : ` — ${note}`}`);
  for (const row of rows.slice(0, limit)) {
    out.push(`  ${row}`);
  }
  if (rows.length > limit) {
    out.push(`  … and ${rows.length - limit} more`);
  }
}

export function renderPlan(plan: SyncPlan, options: RenderOptions): string[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const discovered =
    plan.create.length +
    plan.adopt.length +
    plan.unchanged +
    plan.update.filter(entry => !plan.adopt.some(adopted => adopted.test === entry.test)).length +
    plan.dangling.length;

  const out: string[] = [
    `tests in the suite   ${discovered}`,
    `cases in the tool    ${options.existingCount}`,
    '',
    `  create     ${String(plan.create.length).padStart(4)}`,
    `  adopt      ${String(plan.adopt.length).padStart(4)}`,
    `  update     ${String(plan.update.length).padStart(4)}`,
    `  unchanged  ${String(plan.unchanged).padStart(4)}`,
    `  orphans    ${String(plan.orphans.length).padStart(4)}`,
  ];
  if (plan.dangling.length > 0) {
    out.push(`  dangling   ${String(plan.dangling.length).padStart(4)}`);
  }

  section(
    out,
    'create',
    plan.create.map(entry => `${name(entry.test)}  ${where(entry.test)}`),
    limit,
    options.applied === true
      ? 'created, id written back'
      : 'new cases; the id is written back into the spec',
  );

  section(
    out,
    'adopt',
    plan.adopt.map(
      entry =>
        `${name(entry.test)}  → case ${entry.caseId}${entry.wasManual ? '  (was manual)' : ''}`,
    ),
    limit,
    'an existing case with this suite path and title; the id is written back',
  );

  section(
    out,
    'update',
    plan.update.map(
      entry => `${name(entry.test)}  → case ${entry.caseId}  [${entry.changed.join(', ')}]`,
    ),
    limit,
  );

  section(
    out,
    'orphans',
    plan.orphans.map(item => `${[...item.suitePath, item.title].join(' › ')}  case ${item.id}`),
    limit,
    'automated in the tool, absent from the code — nothing is deleted; --deprecate-orphans marks them',
  );

  section(
    out,
    'dangling',
    plan.dangling.map(
      entry => `${name(entry.test)}  names case ${entry.caseId}  ${where(entry.test)}`,
    ),
    limit,
    'the annotation points at a case that is not in this project — remove it, or restore the case',
  );

  section(
    out,
    'matched by title only',
    [
      ...new Set(
        plan.unwritable.map(
          test => `${where(test)}  ${test.unwritableReason ?? 'no writable call site'}`,
        ),
      ),
    ],
    limit,
    'no id can be written at these call sites, so they stay linked by title and break on a rename',
  );

  return out;
}
