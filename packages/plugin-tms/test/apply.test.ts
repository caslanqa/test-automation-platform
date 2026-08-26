/**
 * Executing a plan, with the filesystem and the provider both injected.
 *
 * The ordering assertion is the important one. Ids are written back **before** the update pass runs, so
 * a failure halfway through leaves a repository that a re-run finishes rather than one that creates a
 * second set of cases; and edits within a file go bottom-up, so an insertion never invalidates the line
 * number of an edit still to come.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NewTmsCase, TmsCase, TmsCasePatch, TmsProvider } from '../src/provider.js';
import { applySync } from '../src/sync/apply.js';
import { planSync } from '../src/sync/diff.js';
import type { DiscoveredTest } from '../src/sync/discover.js';

const aTest = (over: Partial<DiscoveredTest> = {}): DiscoveredTest => ({
  file: 'cart.spec.ts',
  suitePath: ['cart'],
  title: 'a',
  line: 1,
  column: 5,
  tags: [],
  caseIds: [],
  requirements: [],
  projects: ['chromium'],
  ...over,
});

interface Recorder {
  provider: TmsProvider;
  calls: string[];
  updates: Array<{ id: string; patch: TmsCasePatch }>;
}

function recorder(existing: TmsCase[] = [], nextId = 100): Recorder {
  const calls: string[] = [];
  const updates: Array<{ id: string; patch: TmsCasePatch }> = [];
  let id = nextId;
  const provider: TmsProvider = {
    id: 'stub',
    probe: () => Promise.resolve({ ok: true, checks: [] }),
    createRun: () => Promise.resolve({ id: '1' }),
    completeRun: () => Promise.resolve(),
    requirementSupport: () => Promise.resolve({ ok: true, detail: 'stub' }),
    listCases: () => Promise.resolve(existing),
    createCases: (cases: NewTmsCase[]) => {
      calls.push('create');
      return Promise.resolve(cases.map(item => ({ ref: item.ref, id: String(id++) })));
    },
    updateCase: (caseId: string, patch: TmsCasePatch) => {
      calls.push('update');
      updates.push({ id: caseId, patch });
      return Promise.resolve();
    },
    createReporter: () => null,
  };
  return { provider, calls, updates };
}

/** An in-memory filesystem, so nothing here touches a real spec file. */
function memory(files: Record<string, string>) {
  const written: Record<string, string> = {};
  return {
    written,
    readFile: (file: string) => {
      const key = Object.keys(files).find(candidate => file.endsWith(candidate));
      if (key === undefined) {
        throw new Error(`ENOENT: ${file}`);
      }
      return written[key] ?? files[key];
    },
    writeFile: (file: string, source: string) => {
      const key = Object.keys(files).find(candidate => file.endsWith(candidate)) ?? file;
      written[key] = source;
    },
  };
}

test('a created case has its id written into the spec', async () => {
  const source = `test('a', async () => {});\n`;
  const fs = memory({ 'cart.spec.ts': source });
  const { provider } = recorder();

  const result = await applySync(provider, planSync([aTest()], []), {
    rootDir: '/repo/tests',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  assert.equal(result.created, 1);
  assert.equal(result.written, 1);
  assert.deepEqual(result.refusals, []);
  assert.match(fs.written['cart.spec.ts'], /annotation: \{ type: 'QaseID', description: '100' \}/);
});

test('several edits in one file are applied bottom-up, so every line number stays valid', async () => {
  const source = [`test('a', async () => {});`, `test('b', async () => {});`, ``].join('\n');
  const fs = memory({ 'cart.spec.ts': source });
  const { provider } = recorder();

  const plan = planSync([aTest({ title: 'a', line: 1 }), aTest({ title: 'b', line: 2 })], []);
  const result = await applySync(provider, plan, {
    rootDir: '/repo/tests',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  assert.equal(result.written, 2);
  const [lineA, lineB] = fs.written['cart.spec.ts'].split('\n');
  assert.match(lineA, /'a', \{ annotation: \{ type: 'QaseID', description: '100' \} \}/);
  assert.match(lineB, /'b', \{ annotation: \{ type: 'QaseID', description: '101' \} \}/);
});

test('ids are written before any update call, so a half-finished run is resumable', async () => {
  const fs = memory({ 'cart.spec.ts': `test('a', async () => {});\n` });
  const { provider, calls } = recorder([
    {
      id: '7',
      title: 'different',
      suitePath: ['cart'],
      tags: [],
      requirements: [],
      automated: true,
    },
  ]);

  // A test linked to case 7 whose title drifted: an update, with no create.
  await applySync(
    provider,
    planSync(
      [aTest({ caseIds: [7] })],
      [
        {
          id: '7',
          title: 'different',
          suitePath: ['cart'],
          tags: [],
          requirements: [],
          automated: true,
        },
      ],
    ),
    {
      rootDir: '/repo/tests',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    },
  );

  assert.deepEqual(calls, ['create', 'update'], 'create runs first even when it creates nothing');
});

test('a parameterised test gets a case but no annotation — the call site is shared', async () => {
  const fs = memory({ 'roles.spec.ts': `test(\`works for \${role}\`, async () => {});\n` });
  const { provider } = recorder();

  const plan = planSync(
    [
      aTest({
        file: 'roles.spec.ts',
        title: 'works for admin',
        unwritableReason: 'several tests share this test() call',
      }),
      aTest({
        file: 'roles.spec.ts',
        title: 'works for user',
        unwritableReason: 'several tests share this test() call',
      }),
    ],
    [],
  );
  const result = await applySync(provider, plan, {
    rootDir: '/repo/tests',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  assert.equal(result.created, 2);
  assert.equal(result.written, 0);
  assert.equal(fs.written['roles.spec.ts'], undefined, 'the file is untouched');
});

test('a refusal reports the file, the line and the snippet, and does not lose the case', async () => {
  const fs = memory({ 'cart.spec.ts': `test(TITLE, async () => {});\n` });
  const { provider } = recorder();

  const result = await applySync(provider, planSync([aTest()], []), {
    rootDir: '/repo/tests',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  assert.equal(result.created, 1, 'the case exists — only the link is unwritten');
  assert.equal(result.written, 0);
  assert.equal(result.refusals.length, 1);
  assert.equal(result.refusals[0].file, 'cart.spec.ts');
  assert.equal(result.refusals[0].line, 1);
  assert.match(result.refusals[0].snippet, /QaseID/);
});

test('an unreadable file becomes a refusal, not a crash that abandons the rest', async () => {
  const fs = memory({ 'other.spec.ts': '' });
  const { provider } = recorder();

  const result = await applySync(provider, planSync([aTest()], []), {
    rootDir: '/repo/tests',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  assert.equal(result.refusals.length, 1);
  assert.match(result.refusals[0].reason, /could not read the file/);
});

test('orphans are untouched unless --deprecate-orphans is passed', async () => {
  const orphan: TmsCase = {
    id: '9',
    title: 'gone',
    suitePath: ['cart'],
    tags: [],
    requirements: [],
    automated: true,
  };
  const fs = memory({ 'cart.spec.ts': '' });

  const quiet = recorder([orphan]);
  const left = await applySync(quiet.provider, planSync([], [orphan]), {
    rootDir: '/repo/tests',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });
  assert.equal(left.deprecated, 0);
  assert.deepEqual(quiet.updates, []);

  const asked = recorder([orphan]);
  const marked = await applySync(asked.provider, planSync([], [orphan]), {
    rootDir: '/repo/tests',
    deprecateOrphans: true,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });
  assert.equal(marked.deprecated, 1);
  assert.deepEqual(asked.updates, [{ id: '9', patch: { deprecated: true } }]);
});
