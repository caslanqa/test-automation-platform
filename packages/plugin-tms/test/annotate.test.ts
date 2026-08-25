/**
 * The source editor — the only code here that writes to somebody else's file.
 *
 * Every case below is a real spec shape, and the refusals matter as much as the insertions: a wrong
 * insertion corrupts a spec file, while a refusal is a line in a report and a snippet to paste. So the
 * assertions come in pairs — what it does, and what it declines to do.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { insertQaseId } from '../src/sync/annotate.js';

/** Line/column of the `(` in the first `test(` call, the way the runner reports it. */
function callSite(source: string): { line: number; column: number } {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const at = lines[index].indexOf('test(');
    if (at !== -1) {
      return { line: index + 1, column: at + 'test'.length + 1 };
    }
  }
  throw new Error('no test( in the fixture');
}

function apply(source: string, id = 42): string {
  const { line, column } = callSite(source);
  const result = insertQaseId(source, line, column, id);
  assert.ok(result.ok, `refused: ${result.reason}`);
  return result.source as string;
}

function refusal(source: string): string {
  const { line, column } = callSite(source);
  const result = insertQaseId(source, line, column, 42);
  assert.equal(result.ok, false, 'expected a refusal, got an edit');
  return result.reason as string;
}

test('a test with no options object gets one', () => {
  assert.equal(
    apply(`test('rejects an expired card', async () => {});\n`),
    `test('rejects an expired card', { annotation: { type: 'QaseID', description: '42' } }, async () => {});\n`,
  );
});

test('an existing options object gains the key, keeping what was there', () => {
  assert.equal(
    apply(`test('x', { tag: ['@smoke'] }, async () => {});\n`),
    `test('x', { annotation: { type: 'QaseID', description: '42' }, tag: ['@smoke'] }, async () => {});\n`,
  );
});

test('an existing single annotation becomes an array rather than being overwritten', () => {
  assert.equal(
    apply(
      `test('x', { annotation: { type: 'Requirement', description: 'PAY-17' } }, async () => {});\n`,
    ),
    `test('x', { annotation: [{ type: 'Requirement', description: 'PAY-17' }, { type: 'QaseID', description: '42' }] }, async () => {});\n`,
  );
});

test('an existing annotation array is appended to', () => {
  assert.equal(
    apply(
      `test('x', { annotation: [{ type: 'Requirement', description: 'PAY-17' }] }, async () => {});\n`,
    ),
    `test('x', { annotation: [{ type: 'Requirement', description: 'PAY-17' }, { type: 'QaseID', description: '42' }] }, async () => {});\n`,
  );
});

test('a template-literal title is scanned past, including a nested substitution', () => {
  const source = 'test(`works for ${`${role}`} today`, async () => {});\n';
  assert.match(apply(source), /today`, \{ annotation: \{ type: 'QaseID'/);
});

test('a title containing a comma, a brace or a quote does not confuse the reader', () => {
  assert.match(
    apply(`test('rejects {a, b}, and it\\'s fine', async () => {});\n`),
    /fine', \{ annotation: \{ type: 'QaseID', description: '42' \} \}, async/,
  );
});

test('a comment between the arguments is skipped, not parsed', () => {
  assert.match(
    apply(`test('x', /* the options */ { tag: ['@a'] }, async () => {});\n`),
    /\{ annotation: \{ type: 'QaseID', description: '42' \}, tag/,
  );
});

test('a brace inside a tag string does not close the options object early', () => {
  const source = `test('x', { tag: ['@a}b'], grep: 1 }, async () => {});\n`;
  const edited = apply(source);
  assert.match(
    edited,
    /\{ annotation: \{ type: 'QaseID', description: '42' \}, tag: \['@a}b'\], grep: 1 \}/,
  );
});

test('an annotation key belonging to a nested object is not mistaken for the top-level one', () => {
  const source = `test('x', { use: { annotation: 1 }, tag: ['@a'] }, async () => {});\n`;
  const edited = apply(source);
  // The key must be added at the top level, and the nested one left exactly as it was.
  assert.match(
    edited,
    /^test\('x', \{ annotation: \{ type: 'QaseID', description: '42' \}, use: \{ annotation: 1 \}/,
  );
});

test('the edit adds no line, so bottom-up application keeps every other line number valid', () => {
  const source = `test('a', async () => {});\ntest('b', async () => {});\n`;
  assert.equal(apply(source).split('\n').length, source.split('\n').length);
});

test('a variable title is refused rather than guessed at', () => {
  assert.match(
    refusal(`test(TITLES.expired, async () => {});\n`),
    /not a plain string or template literal/,
  );
});

test('a title-only call has nothing to attach options to', () => {
  assert.match(refusal(`test('x');\n`), /no second argument/);
});

test('an annotation built from a variable is refused', () => {
  assert.match(
    refusal(`test('x', { annotation: buildAnnotations() }, async () => {});\n`),
    /neither an object nor an array literal/,
  );
});

test('an unbalanced options object is refused rather than half-edited', () => {
  assert.match(refusal(`test('x', { tag: ['@a'  , async () => {});\n`), /not balanced/);
});

test('a line number that does not hold a test call is refused', () => {
  const result = insertQaseId(`const x = 1;\n`, 1, 5, 42);
  assert.equal(result.ok, false);
  assert.match(result.reason as string, /no test\( call found at line 1/);
});

test('a refusal still hands back a pasteable snippet', () => {
  const { line, column } = callSite(`test(TITLE, async () => {});\n`);
  const result = insertQaseId(`test(TITLE, async () => {});\n`, line, column, 42);
  assert.equal(result.ok, false);
  assert.equal(result.snippet, `annotation: { type: 'QaseID', description: '42' }`);
});
