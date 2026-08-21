/**
 * Loading and validating the definitions we actually ship, plus the validation rules that keep a
 * typo in one of them from rendering a plugin that quietly lost a capability.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DefError, loadDefs, TOOL_MAP } from '../src/agents/defs.js';
import { isKnownToken } from '../src/agents/requires.js';

const AGENTS_DIR = fileURLToPath(new URL('../agents', import.meta.url));
const shipped = loadDefs(AGENTS_DIR);

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A definitions root holding exactly the files given, keyed by `<kind-dir>/<file>.md`. */
function defsRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-defs-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const def = (front: string, body = 'Body.\n'): string => `---\n${front}\n---\n${body}`;

test('the shipped definitions load, and the roster is what the plan says', () => {
  const names = (kind: string): string[] => shipped.filter(d => d.kind === kind).map(d => d.name);

  assert.deepEqual(names('agent'), [
    'mobile-vv',
    'release-gate',
    'run-triage',
    'story-reviewer',
    'suite-reviewer',
    'test-author',
    'test-strategist',
    'vv-lead',
  ]);
  assert.deepEqual(names('skill'), [
    'acceptance-criteria',
    'ai-judge-rubrics',
    'db-state-verification',
    'failure-triage',
    'mobile-locators',
    'perf-budgets',
    'read-run-artifacts',
    'risk-to-layer',
    'spec-conventions',
  ]);
  assert.deepEqual(names('command'), ['vv', 'vv-status']);
});

test('each gated definition is gated on the capability it actually needs', () => {
  const requires = Object.fromEntries(shipped.map(d => [d.name, d.requiresSource]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(requires).filter(([, value]) => value !== 'core')),
    {
      'mobile-vv': 'cap:mobile',
      'mobile-locators': 'cap:mobile',
      'release-gate': 'cap:ci-github',
      'read-run-artifacts': 'cap:allure',
      'db-state-verification': 'plugin:db',
      'perf-budgets': 'plugin:perf',
      'ai-judge-rubrics': 'plugin:ai-judge',
    },
  );
});

test('a core-only project sees 6 agents, 4 skills and both commands', () => {
  const core = shipped.filter(d => d.requiresSource === 'core');
  assert.equal(core.filter(d => d.kind === 'agent').length, 6);
  assert.equal(core.filter(d => d.kind === 'skill').length, 4);
  assert.equal(core.filter(d => d.kind === 'command').length, 2);
});

test('every shipped description is substantive, and model-invoked ones say when to use them', () => {
  for (const d of shipped) {
    assert.ok(d.description.length > 40, `${d.file}: description is too short to be useful`);
  }
  // For an agent or a skill the description *is* the routing signal — it is the only thing the model
  // reads when deciding to reach for it. A command is typed by a human, so its description is a
  // label rather than a trigger.
  for (const d of shipped.filter(d => d.kind !== 'command')) {
    assert.match(d.description, /\bUse (when|before|whenever)\b/, `${d.file}: say when to use it`);
  }
});

test('every shipped agent that is not the lead delegates upward, and the lead does not', () => {
  const lead = shipped.find(d => d.name === 'vv-lead');
  assert.equal(lead?.subagentOf, undefined);
  for (const d of shipped.filter(d => d.kind === 'agent' && d.name !== 'vv-lead')) {
    assert.equal(d.subagentOf, 'vv-lead', `${d.file}: should report to vv-lead`);
  }
});

test('every predicate a definition names uses a recognised token shape', () => {
  for (const d of shipped) {
    for (const alternatives of d.requires) {
      assert.ok(alternatives.length > 0, `${d.file}: empty predicate term`);
      for (const { token } of alternatives) {
        assert.ok(
          isKnownToken(token),
          `${d.file}: '${token}' is not core, plugin:<id> or cap:<name>`,
        );
      }
    }
  }
});

test('every shipped tool name is in the neutral vocabulary', () => {
  for (const d of shipped) {
    for (const tool of d.tools) {
      assert.ok(tool in TOOL_MAP, `${d.file}: ${tool}`);
    }
  }
});

test('load order is stable — kind then name — so a render is byte-stable', () => {
  const again = loadDefs(AGENTS_DIR);
  assert.deepEqual(
    again.map(d => `${d.kind}/${d.name}`),
    shipped.map(d => `${d.kind}/${d.name}`),
  );
});

test('kind comes from the directory, not from a field', () => {
  const defs = loadDefs(
    defsRoot({
      'agents/a.md': def('name: a\ndescription: An agent that does a thing. Use when needed.'),
      'skills/b.md': def('name: b\ndescription: A skill that explains a thing. Use when needed.'),
      'commands/c.md': def('name: c\ndescription: A command a user types. Use when needed.'),
    }),
  );
  assert.deepEqual(
    defs.map(d => [d.kind, d.name]),
    [
      ['agent', 'a'],
      ['command', 'c'],
      ['skill', 'b'],
    ],
  );
});

test('a name that does not match the filename is refused', () => {
  assert.throws(
    () => loadDefs(defsRoot({ 'agents/a.md': def('name: b\ndescription: x '.repeat(4)) })),
    (err: unknown) => {
      assert.ok(err instanceof DefError);
      assert.match(err.message, /'name' is 'b' but the file is 'a\.md'/);
      return true;
    },
  );
});

test('a missing description is refused, because it is what the model reads', () => {
  assert.throws(
    () => loadDefs(defsRoot({ 'agents/a.md': def('name: a') })),
    /'description' is required/,
  );
});

test('a name that is not kebab-case is refused', () => {
  assert.throws(
    () => loadDefs(defsRoot({ 'agents/Ag_1.md': def('name: Ag_1\ndescription: aaaaaaaaaa') })),
    /must be kebab-case/,
  );
});

test('an unknown frontmatter key is refused rather than silently dropped', () => {
  assert.throws(
    () =>
      loadDefs(defsRoot({ 'agents/a.md': def('name: a\ndescription: aaaaaaaaaa\ncolour: red') })),
    /unknown frontmatter key 'colour'/,
  );
});

test('an unknown tool is refused and the message lists the vocabulary', () => {
  assert.throws(
    () =>
      loadDefs(
        defsRoot({ 'agents/a.md': def('name: a\ndescription: aaaaaaaaaa\ntools: [read, browse]') }),
      ),
    /unknown tool 'browse' — the neutral vocabulary is read, search, write, shell, web, task/,
  );
});

test('an unknown target is refused', () => {
  assert.throws(
    () =>
      loadDefs(
        defsRoot({ 'agents/a.md': def('name: a\ndescription: aaaaaaaaaa\ntargets: [cursor]') }),
      ),
    /unknown target 'cursor'/,
  );
});

test('agent-only keys on a skill are refused', () => {
  assert.throws(
    () => loadDefs(defsRoot({ 'skills/s.md': def('name: s\ndescription: aaaaaaaaaa\nowns: [x]') })),
    /'owns' is only valid on an agent, and this is a skill/,
  );
});

test('owns must name a definition, and it must not be an agent', () => {
  assert.throws(
    () =>
      loadDefs(defsRoot({ 'agents/a.md': def('name: a\ndescription: aaaaaaaaaa\nowns: [nope]') })),
    /owns 'nope', which is not a definition/,
  );
  assert.throws(
    () =>
      loadDefs(
        defsRoot({
          'agents/a.md': def('name: a\ndescription: aaaaaaaaaa\nowns: [b]'),
          'agents/b.md': def('name: b\ndescription: aaaaaaaaaa'),
        }),
      ),
    /owns 'b', which is an agent/,
  );
});

test('subagentOf must name an agent', () => {
  assert.throws(
    () =>
      loadDefs(
        defsRoot({
          'agents/a.md': def('name: a\ndescription: aaaaaaaaaa\nsubagentOf: s'),
          'skills/s.md': def('name: s\ndescription: aaaaaaaaaa'),
        }),
      ),
    /subagentOf 's' is not an agent/,
  );
});

test('two definitions may not share a name, whatever their kind', () => {
  assert.throws(
    () =>
      loadDefs(
        defsRoot({
          'agents/x.md': def('name: x\ndescription: aaaaaaaaaa'),
          'skills/x.md': def('name: x\ndescription: aaaaaaaaaa'),
        }),
      ),
    /duplicate definition name 'x'/,
  );
});

test('targets default to all three loops, and tools default to none', () => {
  const [only] = loadDefs(defsRoot({ 'skills/s.md': def('name: s\ndescription: aaaaaaaaaa') }));
  assert.deepEqual(only.targets, ['claude', 'agents-md', 'copilot']);
  assert.deepEqual(only.tools, []);
  assert.equal(only.requiresSource, 'core');
});

test('a missing kind directory is not an error — a root may ship only skills', () => {
  const defs = loadDefs(defsRoot({ 'skills/s.md': def('name: s\ndescription: aaaaaaaaaa') }));
  assert.equal(defs.length, 1);
});
