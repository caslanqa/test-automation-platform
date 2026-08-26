/**
 * The requirements traceability matrix: which requirement is verified by which test, and what that
 * test last did.
 *
 * Pure — requirements in, discovered tests in, matrix out — so the report, the gate and the tests all
 * read the same computation. The join is the `Requirement` annotation a spec carries:
 *
 * ```ts
 * test('rejects an expired card', { annotation: { type: 'Requirement', description: 'PAY-17#AC-1' } }, …)
 * ```
 *
 * `PAY-17` covers the requirement as a whole; `PAY-17#AC-1` covers it **and** that one acceptance
 * criterion. Both forms count toward requirement coverage, which is deliberate: a team that has not
 * adopted criterion-level linking must not be told its whole matrix is empty.
 *
 * Two distinctions the matrix keeps separate, because conflating them is how a matrix starts lying:
 *
 * | | Question | Answer from |
 * |---|---|---|
 * | **Covered** | is there a test that claims to verify this? | the annotations, statically |
 * | **Verified** | did that test actually pass? | the last run's results report |
 *
 * A requirement with a red test is COVERED and NOT VERIFIED. Reporting it as covered-and-done is the
 * failure mode this whole feature exists to prevent.
 *
 * @example
 * const matrix = buildMatrix(requirements, tests);
 * matrix.rows[0].verdict; // 'verified' | 'failing' | 'not-run' | 'uncovered' | 'excluded'
 */
import type { DiscoveredTest } from '../sync/discover.js';
import type { AcceptanceCriterion, Requirement, RequirementStatus } from './load.js';

/** Statuses a coverage gate holds to account. A draft or a retired requirement is not a gap. */
export const GATED_STATUSES: readonly RequirementStatus[] = ['valid', 'implemented'];

export type Verdict = 'verified' | 'failing' | 'not-run' | 'uncovered' | 'excluded';

export interface TracedTest {
  /** `checkout › cart › rejects an expired card` — how a human names it. */
  name: string;
  file: string;
  line: number;
  /** Case ids this test is linked to, so the matrix can point at the tool. */
  caseIds: number[];
  /** From the last results report, or `undefined` when the suite has not been run. */
  outcome?: string;
}

export interface CriterionRow {
  criterion: AcceptanceCriterion;
  tests: TracedTest[];
  verdict: Verdict;
}

export interface MatrixRow {
  requirement: Requirement;
  /** Tests that name the requirement, at either granularity. */
  tests: TracedTest[];
  criteria: CriterionRow[];
  verdict: Verdict;
}

/** A test naming a requirement no file defines — a typo, or a deleted requirement. */
export interface DanglingRef {
  test: TracedTest;
  reference: string;
}

export interface Matrix {
  rows: MatrixRow[];
  dangling: DanglingRef[];
  /** Tests carrying no `Requirement` annotation at all. Counted, not listed — most suites have many. */
  unlinkedTests: number;
  totalTests: number;
}

const FAILED = new Set(['failed', 'timedOut', 'interrupted']);

function named(test: DiscoveredTest): TracedTest {
  return {
    name: [...test.suitePath, test.title].join(' › '),
    file: test.file,
    line: test.line,
    caseIds: test.caseIds,
    ...(test.outcome === undefined ? {} : { outcome: test.outcome }),
  };
}

/** `PAY-17#AC-1` → `{ requirement: 'PAY-17', criterion: 'AC-1' }`; `PAY-17` → no criterion. */
export function splitReference(reference: string): { requirement: string; criterion?: string } {
  const hash = reference.indexOf('#');
  return hash === -1
    ? { requirement: reference.trim() }
    : {
        requirement: reference.slice(0, hash).trim(),
        criterion: reference.slice(hash + 1).trim(),
      };
}

/**
 * The verdict for a set of tests.
 *
 * Two rules, both about not flattering the repository:
 *
 * - **Failing outranks passing.** One red test among five green ones means the requirement is not
 *   verified, and a matrix that averages that away is worse than no matrix.
 * - **`verified` requires a `passed`.** Anything else — no outcome at all, or a `skipped` — is
 *   `not-run`. A skipped test proves nothing, and "there is a test and it did not fail" is not the
 *   same claim as "a test proved this".
 */
function verdictFor(tests: readonly TracedTest[], excluded: boolean): Verdict {
  if (excluded) {
    return 'excluded';
  }
  if (tests.length === 0) {
    return 'uncovered';
  }
  if (tests.some(test => test.outcome !== undefined && FAILED.has(test.outcome))) {
    return 'failing';
  }
  return tests.some(test => test.outcome === 'passed') ? 'verified' : 'not-run';
}

export function buildMatrix(
  requirements: readonly Requirement[],
  tests: readonly DiscoveredTest[],
): Matrix {
  const byRequirement = new Map<string, TracedTest[]>();
  const byCriterion = new Map<string, TracedTest[]>();
  const dangling: DanglingRef[] = [];
  const known = new Set(requirements.map(requirement => requirement.id));

  let unlinkedTests = 0;
  for (const test of tests) {
    if (test.requirements.length === 0) {
      unlinkedTests += 1;
      continue;
    }
    const traced = named(test);
    for (const reference of test.requirements) {
      const { requirement, criterion } = splitReference(reference);
      if (!known.has(requirement)) {
        dangling.push({ test: traced, reference });
        continue;
      }
      const forRequirement = byRequirement.get(requirement);
      if (forRequirement === undefined) {
        byRequirement.set(requirement, [traced]);
      } else if (!forRequirement.includes(traced)) {
        forRequirement.push(traced);
      }
      if (criterion !== undefined && criterion !== '') {
        const key = `${requirement}#${criterion}`;
        const forCriterion = byCriterion.get(key);
        if (forCriterion === undefined) {
          byCriterion.set(key, [traced]);
        } else if (!forCriterion.includes(traced)) {
          forCriterion.push(traced);
        }
      }
    }
  }

  const rows = requirements.map<MatrixRow>(requirement => {
    const excluded = !GATED_STATUSES.includes(requirement.status);
    const linked = byRequirement.get(requirement.id) ?? [];
    return {
      requirement,
      tests: linked,
      criteria: requirement.criteria.map<CriterionRow>(criterion => {
        const forCriterion = byCriterion.get(`${requirement.id}#${criterion.id}`) ?? [];
        return { criterion, tests: forCriterion, verdict: verdictFor(forCriterion, excluded) };
      }),
      verdict: verdictFor(linked, excluded),
    };
  });

  return { rows, dangling, unlinkedTests, totalTests: tests.length };
}

// --- rendering -----------------------------------------------------------------------------------

export interface RenderContext {
  /** Git sha the matrix describes, so an exported report is attributable. */
  sha: string;
  branch: string;
  /** ISO timestamp, passed in rather than read, so a render is reproducible in a test. */
  generatedAt: string;
  /** Where the run statuses came from, or `undefined` when the suite has not been run. */
  resultsFile?: string;
}

const SYMBOL: Record<Verdict, string> = {
  verified: '✅',
  failing: '❌',
  'not-run': '⚪',
  uncovered: '🚫',
  excluded: '➖',
};

const LABEL: Record<Verdict, string> = {
  verified: 'verified',
  failing: 'failing',
  'not-run': 'not run',
  uncovered: 'UNCOVERED',
  excluded: 'excluded',
};

export function countByVerdict(matrix: Matrix): Record<Verdict, number> {
  const counts: Record<Verdict, number> = {
    verified: 0,
    failing: 0,
    'not-run': 0,
    uncovered: 0,
    excluded: 0,
  };
  for (const row of matrix.rows) {
    counts[row.verdict] += 1;
  }
  return counts;
}

/** Escape a cell for a markdown table — a `|` in a requirement title would otherwise split the row. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(matrix: Matrix, context: RenderContext): string {
  const counts = countByVerdict(matrix);
  const lines: string[] = [
    '# Requirements traceability matrix',
    '',
    `Generated ${context.generatedAt} from \`${context.branch || 'HEAD'}\` at \`${context.sha || 'unknown'}\`.`,
    context.resultsFile === undefined
      ? 'No run results were read, so every covered requirement reads as **not run**.'
      : `Run outcomes read from \`${context.resultsFile}\`.`,
    '',
    `| Verdict | Count |`,
    `| --- | --- |`,
    ...(Object.keys(SYMBOL) as Verdict[]).map(
      verdict => `| ${SYMBOL[verdict]} ${LABEL[verdict]} | ${counts[verdict]} |`,
    ),
    '',
    `${matrix.totalTests} tests in the suite, ${matrix.unlinkedTests} of them with no requirement link.`,
    '',
    '## Matrix',
    '',
    '| Requirement | Title | Status | Verdict | Tests |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const row of matrix.rows) {
    lines.push(
      `| \`${cell(row.requirement.id)}\` | ${cell(row.requirement.title)} | ${row.requirement.status} | ${SYMBOL[row.verdict]} ${LABEL[row.verdict]} | ${row.tests.length} |`,
    );
    for (const criterion of row.criteria) {
      lines.push(
        `| ↳ \`${cell(criterion.criterion.id)}\` | ${cell(criterion.criterion.text)} | | ${SYMBOL[criterion.verdict]} ${LABEL[criterion.verdict]} | ${criterion.tests.length} |`,
      );
    }
  }

  const uncovered = matrix.rows.filter(row => row.verdict === 'uncovered');
  if (uncovered.length > 0) {
    lines.push('', '## Uncovered', '');
    for (const row of uncovered) {
      lines.push(
        `- \`${row.requirement.id}\` — ${cell(row.requirement.title)} (${row.requirement.file})`,
      );
    }
  }

  const failing = matrix.rows.filter(row => row.verdict === 'failing');
  if (failing.length > 0) {
    lines.push('', '## Failing', '');
    for (const row of failing) {
      const red = row.tests.filter(test => test.outcome !== undefined && FAILED.has(test.outcome));
      lines.push(`- \`${row.requirement.id}\` — ${cell(row.requirement.title)}`);
      for (const test of red) {
        lines.push(`  - ${cell(test.name)} (${test.file}:${test.line}) — ${test.outcome}`);
      }
    }
  }

  if (matrix.dangling.length > 0) {
    lines.push('', '## References to requirements that do not exist', '');
    for (const entry of matrix.dangling) {
      lines.push(
        `- \`${cell(entry.reference)}\` — ${cell(entry.test.name)} (${entry.test.file}:${entry.test.line})`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function renderJson(matrix: Matrix, context: RenderContext): string {
  return `${JSON.stringify(
    {
      schema: 'pwtap.tms.rtm/1',
      generatedAt: context.generatedAt,
      branch: context.branch,
      sha: context.sha,
      resultsFile: context.resultsFile ?? null,
      counts: countByVerdict(matrix),
      totalTests: matrix.totalTests,
      unlinkedTests: matrix.unlinkedTests,
      requirements: matrix.rows.map(row => ({
        id: row.requirement.id,
        title: row.requirement.title,
        status: row.requirement.status,
        type: row.requirement.type,
        parent: row.requirement.parent ?? null,
        file: row.requirement.file,
        verdict: row.verdict,
        tests: row.tests,
        criteria: row.criteria.map(criterion => ({
          id: criterion.criterion.id,
          text: criterion.criterion.text,
          verdict: criterion.verdict,
          tests: criterion.tests,
        })),
      })),
      dangling: matrix.dangling,
    },
    null,
    2,
  )}\n`;
}

/** RFC 4180: quote everything, double an embedded quote. Auditors open this in a spreadsheet. */
const csvCell = (text: string): string => `"${text.replace(/"/g, '""')}"`;

export function renderCsv(matrix: Matrix, context: RenderContext): string {
  const rows: string[][] = [
    [
      'requirement',
      'title',
      'status',
      'criterion',
      'criterion_text',
      'verdict',
      'test',
      'file',
      'case_ids',
      'outcome',
    ],
  ];

  const push = (
    row: MatrixRow,
    criterion: CriterionRow | undefined,
    test: TracedTest | undefined,
    verdict: Verdict,
  ): void => {
    rows.push([
      row.requirement.id,
      row.requirement.title,
      row.requirement.status,
      criterion?.criterion.id ?? '',
      criterion?.criterion.text ?? '',
      verdict,
      test?.name ?? '',
      test === undefined ? '' : `${test.file}:${test.line}`,
      (test?.caseIds ?? []).join(' '),
      test?.outcome ?? '',
    ]);
  };

  for (const row of matrix.rows) {
    // One line per requirement even when nothing links to it — an empty row IS the finding.
    if (row.tests.length === 0) {
      push(row, undefined, undefined, row.verdict);
    }
    for (const test of row.tests) {
      push(row, undefined, test, row.verdict);
    }
    for (const criterion of row.criteria) {
      if (criterion.tests.length === 0) {
        push(row, criterion, undefined, criterion.verdict);
      }
      for (const test of criterion.tests) {
        push(row, criterion, test, criterion.verdict);
      }
    }
  }

  const header = `# generated ${context.generatedAt} branch=${context.branch} sha=${context.sha}`;
  return `${header}\n${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}
