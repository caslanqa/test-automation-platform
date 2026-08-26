/**
 * The traceability matrix and the gate.
 *
 * The distinction under test throughout is **covered vs verified**. A requirement with a red test is
 * covered and not verified; a requirement whose test never ran is covered and not verified either. A
 * matrix that collapses those into "has a test → green" is the exact artifact this feature exists to
 * replace, so every verdict has its own case here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gateMatrix } from '../src/requirements/gate.js';
import type { Requirement } from '../src/requirements/load.js';
import {
  buildMatrix,
  countByVerdict,
  renderCsv,
  renderJson,
  renderMarkdown,
  splitReference,
} from '../src/requirements/rtm.js';
import type { DiscoveredTest } from '../src/sync/discover.js';

const requirement = (over: Partial<Requirement> = {}): Requirement => ({
  id: 'PAY-17',
  title: 'An expired card is rejected',
  status: 'valid',
  type: 'user-story',
  criteria: [],
  file: 'requirements/pay-17.md',
  ...over,
});

const aTest = (over: Partial<DiscoveredTest> = {}): DiscoveredTest => ({
  file: 'cart.spec.ts',
  suitePath: ['cart'],
  title: 'rejects an expired card',
  line: 3,
  column: 5,
  tags: [],
  caseIds: [],
  requirements: [],
  projects: ['chromium'],
  ...over,
});

const CONTEXT = { sha: 'a1b2c3d', branch: 'main', generatedAt: '2026-08-26T00:00:00.000Z' };

test('a requirement with no test is uncovered', () => {
  const matrix = buildMatrix([requirement()], [aTest()]);

  assert.equal(matrix.rows[0].verdict, 'uncovered');
  assert.equal(matrix.unlinkedTests, 1);
});

test('a passing linked test verifies it; a failing one does not', () => {
  const passing = buildMatrix(
    [requirement()],
    [aTest({ requirements: ['PAY-17'], outcome: 'passed' })],
  );
  assert.equal(passing.rows[0].verdict, 'verified');

  const failing = buildMatrix(
    [requirement()],
    [aTest({ requirements: ['PAY-17'], outcome: 'failed' })],
  );
  assert.equal(failing.rows[0].verdict, 'failing');
});

test('one red test among green ones still means not verified', () => {
  const matrix = buildMatrix(
    [requirement()],
    [
      aTest({ requirements: ['PAY-17'], outcome: 'passed' }),
      aTest({ requirements: ['PAY-17'], title: 'b', outcome: 'passed' }),
      aTest({ requirements: ['PAY-17'], title: 'c', outcome: 'failed' }),
    ],
  );

  assert.equal(matrix.rows[0].verdict, 'failing');
});

test('a linked test that never ran is covered but not verified', () => {
  const matrix = buildMatrix([requirement()], [aTest({ requirements: ['PAY-17'] })]);

  assert.equal(matrix.rows[0].verdict, 'not-run');
});

test('a SKIPPED test never counts as verified — it proved nothing', () => {
  // The bug this pins: a `--list` report carries `status: "skipped"` on every test, and treating any
  // non-failure as evidence turned "never executed" into green across a whole matrix.
  const matrix = buildMatrix(
    [requirement()],
    [aTest({ requirements: ['PAY-17'], outcome: 'skipped' })],
  );

  assert.equal(matrix.rows[0].verdict, 'not-run');
});

test('one passing test is enough among skipped siblings, but a red one still wins', () => {
  const mixed = buildMatrix(
    [requirement()],
    [
      aTest({ requirements: ['PAY-17'], outcome: 'skipped' }),
      aTest({ requirements: ['PAY-17'], title: 'b', outcome: 'passed' }),
    ],
  );
  assert.equal(mixed.rows[0].verdict, 'verified');

  const red = buildMatrix(
    [requirement()],
    [
      aTest({ requirements: ['PAY-17'], outcome: 'passed' }),
      aTest({ requirements: ['PAY-17'], title: 'b', outcome: 'timedOut' }),
    ],
  );
  assert.equal(red.rows[0].verdict, 'failing');
});

test('a non-gated status is excluded whatever its coverage', () => {
  for (const status of ['draft', 'review', 'obsolete'] as const) {
    const matrix = buildMatrix([requirement({ status })], []);
    assert.equal(matrix.rows[0].verdict, 'excluded', status);
  }
});

test('a requirement-level reference covers the requirement, not the criteria', () => {
  const matrix = buildMatrix(
    [requirement({ criteria: [{ id: 'AC-1', text: 'x' }] })],
    [aTest({ requirements: ['PAY-17'], outcome: 'passed' })],
  );

  assert.equal(matrix.rows[0].verdict, 'verified');
  assert.equal(matrix.rows[0].criteria[0].verdict, 'uncovered');
});

test('a criterion reference covers both levels', () => {
  const matrix = buildMatrix(
    [requirement({ criteria: [{ id: 'AC-1', text: 'x' }] })],
    [aTest({ requirements: ['PAY-17#AC-1'], outcome: 'passed' })],
  );

  assert.equal(matrix.rows[0].verdict, 'verified');
  assert.equal(matrix.rows[0].criteria[0].verdict, 'verified');
});

test('a reference nobody defines is dangling, and does not silently vanish', () => {
  const matrix = buildMatrix([requirement()], [aTest({ requirements: ['PAY-99'] })]);

  assert.equal(matrix.dangling.length, 1);
  assert.equal(matrix.dangling[0].reference, 'PAY-99');
  assert.equal(matrix.rows[0].verdict, 'uncovered');
});

test('one test naming a requirement twice is counted once', () => {
  const matrix = buildMatrix(
    [requirement({ criteria: [{ id: 'AC-1', text: 'x' }] })],
    [aTest({ requirements: ['PAY-17', 'PAY-17#AC-1'], outcome: 'passed' })],
  );

  assert.equal(matrix.rows[0].tests.length, 1);
});

test('a reference splits on the first hash only', () => {
  assert.deepEqual(splitReference('PAY-17'), { requirement: 'PAY-17' });
  assert.deepEqual(splitReference('PAY-17#AC-1'), { requirement: 'PAY-17', criterion: 'AC-1' });
  assert.deepEqual(splitReference(' PAY-17 # AC-1 '), {
    requirement: 'PAY-17',
    criterion: 'AC-1',
  });
});

// --- the gate ------------------------------------------------------------------------------------

test('the gate passes when every gated requirement is verified', () => {
  const matrix = buildMatrix(
    [requirement(), requirement({ id: 'PAY-2', status: 'draft' })],
    [aTest({ requirements: ['PAY-17'], outcome: 'passed' })],
  );

  const verdict = gateMatrix(matrix, { resultsRead: true });
  assert.equal(verdict.ok, true);
  assert.match(verdict.summary, /1 requirement\(s\) held to account, all covered and verified/);
});

test('an uncovered requirement fails the gate and is named', () => {
  const verdict = gateMatrix(buildMatrix([requirement()], []), { resultsRead: true });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.findings[0].kind, 'uncovered');
  assert.equal(verdict.findings[0].subject, 'PAY-17');
});

test('a failing requirement names the tests that went red', () => {
  const matrix = buildMatrix(
    [requirement()],
    [aTest({ requirements: ['PAY-17'], title: 'the red one', outcome: 'failed' })],
  );

  const verdict = gateMatrix(matrix, { resultsRead: true });
  assert.equal(verdict.findings[0].kind, 'failing');
  assert.match(verdict.findings[0].detail, /the red one/);
});

test('not-run fails the gate ONLY when a results report was actually read', () => {
  const matrix = buildMatrix([requirement()], [aTest({ requirements: ['PAY-17'] })]);

  // No results: the gate checks coverage, and says so rather than failing everything as unverified.
  const coverageOnly = gateMatrix(matrix, { resultsRead: false });
  assert.equal(coverageOnly.ok, true);
  assert.match(coverageOnly.summary, /coverage only/);

  // Results WERE read and this requirement's test is not in them — the test never executed, and a green
  // job whose relevant test never ran is not evidence.
  const withResults = gateMatrix(matrix, { resultsRead: true });
  assert.equal(withResults.ok, false);
  assert.equal(withResults.findings[0].kind, 'not-run');
});

test('criteria only gate under --strict', () => {
  const matrix = buildMatrix(
    [requirement({ criteria: [{ id: 'AC-1', text: 'x' }] })],
    [aTest({ requirements: ['PAY-17'], outcome: 'passed' })],
  );

  assert.equal(gateMatrix(matrix, { resultsRead: true }).ok, true);

  const strict = gateMatrix(matrix, { resultsRead: true, strict: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.findings[0].subject, 'PAY-17#AC-1');
});

test('a malformed requirement file fails the gate rather than shrinking the denominator', () => {
  const verdict = gateMatrix(buildMatrix([], []), {
    resultsRead: true,
    problems: [{ file: 'requirements/broken.md', reason: 'no --- frontmatter block' }],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.findings[0].kind, 'problem');
});

test('a dangling reference fails the gate', () => {
  const matrix = buildMatrix([requirement()], [aTest({ requirements: ['PAY-99', 'PAY-17'] })]);

  const verdict = gateMatrix(matrix, { resultsRead: false });
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.findings.map(finding => finding.kind),
    ['dangling'],
  );
});

// --- rendering -----------------------------------------------------------------------------------

test('the markdown report is stamped and names what is uncovered', () => {
  const matrix = buildMatrix(
    [requirement(), requirement({ id: 'PAY-2', title: 'Refunds' })],
    [aTest({ requirements: ['PAY-17'], outcome: 'passed' })],
  );

  const markdown = renderMarkdown(matrix, { ...CONTEXT, resultsFile: 'test-results/results.json' });

  assert.match(markdown, /a1b2c3d/);
  assert.match(markdown, /## Uncovered/);
  assert.match(markdown, /`PAY-2` — Refunds/);
  assert.doesNotMatch(
    markdown,
    /`PAY-17` — An expired/,
    'a verified requirement is not "uncovered"',
  );
});

test('a pipe in a title does not break the markdown table', () => {
  const matrix = buildMatrix([requirement({ title: 'a | b' })], []);

  assert.match(renderMarkdown(matrix, CONTEXT), /a \\\| b/);
});

test('the JSON report is a stable schema with counts and per-requirement verdicts', () => {
  const matrix = buildMatrix(
    [requirement({ criteria: [{ id: 'AC-1', text: 'x' }] })],
    [aTest({ requirements: ['PAY-17#AC-1'], caseIds: [42], outcome: 'passed' })],
  );

  const parsed = JSON.parse(renderJson(matrix, CONTEXT)) as {
    schema: string;
    counts: Record<string, number>;
    resultsFile: string | null;
    requirements: Array<{
      verdict: string;
      criteria: Array<{ verdict: string }>;
      tests: unknown[];
    }>;
  };

  assert.equal(parsed.schema, 'pwtap.tms.rtm/1');
  assert.equal(parsed.counts.verified, 1);
  assert.equal(parsed.resultsFile, null);
  assert.equal(parsed.requirements[0].verdict, 'verified');
  assert.equal(parsed.requirements[0].criteria[0].verdict, 'verified');
});

test('the CSV emits a row for an uncovered requirement — the empty row IS the finding', () => {
  const matrix = buildMatrix([requirement()], []);
  const lines = renderCsv(matrix, CONTEXT).trim().split('\n');

  assert.match(lines[0], /^# generated/);
  assert.match(lines[1], /^"requirement","title"/);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /"PAY-17".*"uncovered"/);
});

test('a quote in a title is doubled, not dropped', () => {
  const matrix = buildMatrix([requirement({ title: 'say "hi"' })], []);

  assert.match(renderCsv(matrix, CONTEXT), /"say ""hi"""/);
});

test('the counts add up to the number of requirements', () => {
  const matrix = buildMatrix(
    [requirement(), requirement({ id: 'B' }), requirement({ id: 'C', status: 'draft' })],
    [aTest({ requirements: ['PAY-17'], outcome: 'passed' })],
  );

  const counts = countByVerdict(matrix);
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    3,
  );
  assert.deepEqual(counts, { verified: 1, failing: 0, 'not-run': 0, uncovered: 1, excluded: 1 });
});
