/**
 * File edits go through the project's TypeScript (ADR-005). The string version these replace dropped every
 * non-`@fixtures` import when merging, and found the insertion point by searching for the last `});` — which
 * lands in the wrong place as soon as a file has a helper, an object literal or a second test.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  insertStatementIntoTest,
  loadProjectTypeScript,
  mergeIntoExistingTest,
  type TypeScriptApi,
} from '../src/service/ast.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let ts: TypeScriptApi | undefined;
const compiler = async (): Promise<TypeScriptApi> => {
  ts ??= await loadProjectTypeScript(REPO_ROOT);
  assert.ok(ts, 'this repo declares typescript, so it must resolve');
  return ts;
};

const DRAFT = `import { test, expect } from '@fixtures';

test.use({ mobileTarget: { driver: 'maestro', platform: 'android' } });

test('recorded flow', async ({ mobileApp }) => {
  await mobileApp.tap({ text: 'Log in' });
});
`;

test('a statement lands inside the test body, at its indentation', async () => {
  const result = insertStatementIntoTest(await compiler(), DRAFT, 'await mobileApp.back();');

  assert.match(result, /tap\(\{ text: 'Log in' \}\);\n {2}await mobileApp\.back\(\);\n\}\);/);
});

test('a trailing object literal no longer steals the insertion point', async () => {
  // The old `lastIndexOf('\\n});\\n')` matched the helper's closing brace, so the statement landed outside
  // the test entirely — and the generated file then failed to compile.
  const withHelper = `${DRAFT}\nexport const fixtures = {\n  user: 'demo',\n};\n`;

  const result = insertStatementIntoTest(await compiler(), withHelper, 'await mobileApp.back();');

  const insertedAt = result.indexOf('await mobileApp.back();');
  assert.ok(insertedAt < result.indexOf('export const fixtures'), 'must stay inside the test');
});

test('the last test in a file is the one recorded into', async () => {
  const two = `${DRAFT}\ntest('second', async ({ mobileApp }) => {\n  await mobileApp.back();\n});\n`;

  const result = insertStatementIntoTest(
    await compiler(),
    two,
    "await mobileApp.pressKey('home');",
  );

  assert.ok(
    result.indexOf('pressKey') > result.indexOf("test('second'"),
    'a recording continues in the test being recorded, which is the last one',
  );
});

test('a draft with no test block still keeps the statement', async () => {
  const result = insertStatementIntoTest(await compiler(), '// emptied by hand\n', 'await x();');

  assert.match(result, /await x\(\);/);
});

test('append merges imports the target does not already have', async () => {
  const existing = `import { test, expect } from '@fixtures';\n\ntest('existing', async () => {});\n`;
  const generated = `import { test, expect } from '@fixtures';\nimport { devices } from '@pwtap/plugin-maestro';\n\ntest('new', async ({ mobileApp }) => {\n  await mobileApp.back();\n});\n`;

  const result = mergeIntoExistingTest(await compiler(), existing, generated, 'recorded');

  assert.match(result, /@pwtap\/plugin-maestro/, 'the import the target lacked must be added');
  assert.equal(
    result.split("from '@fixtures'").length - 1,
    1,
    'the import it already had must not be duplicated',
  );
  assert.match(result, /test\('existing'/, 'existing tests are preserved');
});

test('the appended test is wrapped so its test.use stays scoped to it', async () => {
  const existing = `import { test } from '@fixtures';\n\ntest.use({ mobileTarget: { driver: 'appium' } });\n\ntest('existing', async () => {});\n`;

  const result = mergeIntoExistingTest(await compiler(), existing, DRAFT, 'recorded flow');

  assert.match(result, /test\.describe\("recorded flow", \(\) => \{/);
  // The generated `test.use` must be inside the describe, or it would rewrite the target's own config.
  const describeAt = result.indexOf('test.describe');
  assert.ok(result.indexOf("driver: 'maestro'", describeAt) > describeAt);
});

test('loadProjectTypeScript reports absence instead of throwing', async () => {
  assert.equal(await loadProjectTypeScript('/nonexistent-project-root'), undefined);
});
