/**
 * Reading the suite from `playwright test --list --reporter=json`.
 *
 * The JSON below is not invented — it is the shape the runner actually emits, captured from a real
 * `--list` against nested describes, declared annotations, tags and a parameterised loop. Those four
 * together are the whole contract this module depends on, so they are the fixture.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { discoverTests, fileStem, readResultsReport, testKey } from '../src/sync/discover.js';

/** Scratch directories the results-report cases create, removed when the file is done. */
const after: string[] = [];
test.after(() => {
  for (const dir of after) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ROOT = '/repo/tests';

const listJson = (report: unknown) => () => JSON.stringify(report);

const spec = (
  title: string,
  file: string,
  line: number,
  column: number,
  extra: Record<string, unknown> = {},
) => ({
  title,
  file,
  line,
  column,
  tags: [],
  tests: [{ annotations: [], projectName: 'chromium' }],
  ...extra,
});

test('a file suite contributes the directory and the file stem, describes contribute themselves', () => {
  const { tests, rootDir } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'checkout/cart.spec.ts',
          file: 'checkout/cart.spec.ts',
          specs: [],
          suites: [
            {
              title: 'outer',
              file: 'checkout/cart.spec.ts',
              suites: [
                {
                  title: 'inner',
                  file: 'checkout/cart.spec.ts',
                  specs: [spec('nested one', 'checkout/cart.spec.ts', 4, 9)],
                },
              ],
            },
          ],
        },
      ],
    }),
  });

  assert.equal(rootDir, ROOT);
  assert.deepEqual(tests[0].suitePath, ['checkout', 'cart', 'outer', 'inner']);
  assert.equal(tests[0].title, 'nested one');
  assert.equal(
    testKey(tests[0]),
    ['checkout', 'cart', 'outer', 'inner', 'nested one'].join('\u0000'),
  );
});

test('the match key cannot be forged by a title that contains the separator between two others', () => {
  // A space or a slash would make ['a b'] + 'c' and ['a', 'b'] + 'c' the same key, and the sync would
  // then adopt one test's case for another. NUL cannot appear in a JavaScript identifier or a title
  // anyone types, which is the whole reason it is the separator.
  assert.notEqual(
    testKey({ suitePath: ['a b'], title: 'c' }),
    testKey({ suitePath: ['a', 'b'], title: 'c' }),
  );
});

test('a spec at the top of a file lands directly under the file suite', () => {
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'smoke.spec.ts',
          file: 'smoke.spec.ts',
          specs: [spec('it works', 'smoke.spec.ts', 3, 5)],
        },
      ],
    }),
  });

  assert.deepEqual(tests[0].suitePath, ['smoke']);
});

test('QaseID and Requirement annotations are read, including the comma-separated multi-id form', () => {
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            spec('linked', 'a.spec.ts', 3, 7, {
              tags: ['@smoke', 'slow'],
              tests: [
                {
                  projectName: 'chromium',
                  annotations: [
                    { type: 'QaseID', description: '42,43' },
                    { type: 'Requirement', description: 'PAY-17#AC-1, PAY-18' },
                    { type: 'skip', description: 'flaky on CI' },
                  ],
                },
              ],
            }),
          ],
        },
      ],
    }),
  });

  assert.deepEqual(tests[0].caseIds, [42, 43]);
  assert.deepEqual(tests[0].requirements, ['PAY-17#AC-1', 'PAY-18']);
  assert.deepEqual(
    tests[0].tags,
    ['smoke', 'slow'],
    'the leading @ is Playwright syntax, not a tag name',
  );
});

test('a malformed id is dropped rather than becoming NaN', () => {
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            spec('x', 'a.spec.ts', 1, 1, {
              tests: [
                {
                  projectName: 'chromium',
                  annotations: [{ type: 'QaseID', description: 'forty-two, 0, -3, 7' }],
                },
              ],
            }),
          ],
        },
      ],
    }),
  });

  assert.deepEqual(tests[0].caseIds, [7]);
});

test('tests sharing one test() call are marked parameterised — an id there would name all of them', () => {
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'roles.spec.ts',
          file: 'roles.spec.ts',
          specs: [
            spec('works for admin', 'roles.spec.ts', 9, 9),
            spec('works for user', 'roles.spec.ts', 9, 9),
            spec('alone', 'roles.spec.ts', 14, 5),
          ],
        },
      ],
    }),
  });

  assert.deepEqual(
    tests.map(item => [item.title, item.unwritableReason !== undefined]),
    [
      ['works for admin', true],
      ['works for user', true],
      ['alone', false],
    ],
  );
});

test('a test declared outside the tests directory is never written to', () => {
  // What a `test.as('admin')(…)` helper looks like from the runner: the `test(` call is in the helper,
  // so an annotation there would tag the helper and, through it, every test it has ever created.
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: '../fixtures/ui.ts',
          file: '../fixtures/ui.ts',
          specs: [spec('admin reaches the inventory', '../fixtures/ui.ts', 107, 5)],
        },
      ],
    }),
  });

  assert.equal(tests.length, 1, 'it is still a real test and still gets a case');
  assert.match(tests[0].unwritableReason ?? '', /outside the tests directory/);
});

test('a lone test in a spec file has no reason not to be written to', () => {
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        { title: 'a.spec.ts', file: 'a.spec.ts', specs: [spec('alone', 'a.spec.ts', 3, 5)] },
      ],
    }),
  });

  assert.equal(tests[0].unwritableReason, undefined);
});

test('one spec in two projects is one test, with both project names', () => {
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            spec('shared', 'a.spec.ts', 3, 5, {
              tests: [
                { projectName: 'chromium', annotations: [] },
                { projectName: 'firefox', annotations: [] },
              ],
            }),
          ],
        },
      ],
    }),
  });

  assert.equal(tests.length, 1);
  assert.deepEqual(tests[0].projects, ['chromium', 'firefox']);
});

test('a suite that failed to load stops the sync instead of looking like a deletion', () => {
  assert.throws(
    () =>
      discoverTests('/repo', {
        listJson: listJson({
          config: { rootDir: ROOT },
          suites: [],
          errors: [{ message: "Cannot find module './missing'" }],
        }),
      }),
    /could not load the suite[\s\S]*Cannot find module/,
  );
});

test('unparseable output says how to see the real error', () => {
  assert.throws(
    () => discoverTests('/repo', { listJson: () => 'Error: no config found' }),
    /could not parse Playwright's list output/,
  );
});

test('the file stem drops the project-selecting suffix, not the name', () => {
  assert.equal(fileStem('checkout/cart.spec.ts'), 'cart');
  assert.equal(fileStem('api/users.api.ts'), 'users');
  assert.equal(fileStem('legacy/a.b.test.ts'), 'a.b');
  assert.equal(fileStem('plain.ts'), 'plain');
});

test('a results report is read by the same parser, and the worst outcome wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-results-'));
  after.push(dir);
  const file = path.join(dir, 'results.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            // Green on one project, red on another: one test, and it is a failing one. A matrix that
            // reported this as passed is the reason nobody trusts matrices.
            spec('cross-browser', 'a.spec.ts', 3, 5, {
              tests: [
                { projectName: 'chromium', annotations: [], results: [{ status: 'passed' }] },
                { projectName: 'webkit', annotations: [], results: [{ status: 'failed' }] },
              ],
            }),
            // Failed then passed on retry: the last attempt is what the test did.
            spec('flaky', 'a.spec.ts', 9, 5, {
              tests: [
                {
                  projectName: 'chromium',
                  annotations: [],
                  results: [{ status: 'failed' }, { status: 'passed' }],
                },
              ],
            }),
            spec('never ran', 'a.spec.ts', 14, 5, {
              tests: [{ projectName: 'chromium', results: [] }],
            }),
          ],
        },
      ],
    }),
    'utf8',
  );

  const { tests } = readResultsReport(file);

  assert.deepEqual(
    tests.map(item => [item.title, item.outcome]),
    [
      ['cross-browser', 'failed'],
      ['flaky', 'passed'],
      ['never ran', undefined],
    ],
  );
});

test('a --list report gives no outcome, whatever placeholder status it carries', () => {
  // Playwright's `--list` writes `status: "skipped"` on every test. Reading that as an outcome made a
  // listed-but-never-executed test look verified in the traceability matrix.
  const { tests } = discoverTests('/repo', {
    listJson: listJson({
      config: { rootDir: ROOT },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            spec('listed only', 'a.spec.ts', 3, 5, {
              tests: [{ projectName: 'chromium', annotations: [], results: [], status: 'skipped' }],
            }),
          ],
        },
      ],
    }),
  });

  assert.equal(tests[0].outcome, undefined);
});

test('a missing results file is an empty discovery, not an error', () => {
  assert.deepEqual(readResultsReport('/nowhere/results.json').tests, []);
});

test('a results file that is not a Playwright report says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-results-'));
  after.push(dir);
  const file = path.join(dir, 'results.json');
  fs.writeFileSync(file, 'not json', 'utf8');

  assert.throws(() => readResultsReport(file), /is not a Playwright JSON report/);
});
