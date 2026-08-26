/**
 * The requirement loader.
 *
 * The refusals matter more than the happy path: a requirement file that silently fails to parse
 * shrinks the denominator, and a coverage gate computed over a smaller set reports better numbers
 * for a worse repository. So every malformed shape below becomes a reported problem, never a skip.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadRequirements } from '../src/requirements/load.js';

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A project whose `requirements/` holds the given files. */
function projectWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-req-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, 'requirements', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return dir;
}

const FULL = `---
id: PAY-17
title: An expired card is rejected
status: valid
type: user-story
parent: PAY-1
---

## Acceptance criteria

1. **AC-1** — Returns HTTP 422 with \`card_expired\`.
2. **AC-2** — Shows "Your card has expired".
`;

const PARENT = `---
id: PAY-1
title: Payments
type: epic
---
`;

test('a complete requirement round-trips, criteria included', () => {
  const { requirements, problems } = loadRequirements(
    projectWith({ 'pay-17.md': FULL, 'pay-1.md': PARENT }),
  );

  assert.deepEqual(problems, []);
  const pay17 = requirements.find(item => item.id === 'PAY-17');
  assert.equal(pay17?.title, 'An expired card is rejected');
  assert.equal(pay17?.status, 'valid');
  assert.equal(pay17?.parent, 'PAY-1');
  assert.deepEqual(
    pay17?.criteria.map(criterion => criterion.id),
    ['AC-1', 'AC-2'],
  );
  assert.match(pay17?.criteria[0].text ?? '', /HTTP 422/);
});

test('status and type default rather than being required', () => {
  const { requirements } = loadRequirements(
    projectWith({ 'a.md': '---\nid: A-1\ntitle: Something\n---\n' }),
  );

  assert.equal(requirements[0].status, 'valid');
  assert.equal(requirements[0].type, 'user-story');
  assert.equal(requirements[0].parent, undefined);
  assert.deepEqual(requirements[0].criteria, []);
});

test('criteria are found in any markdown shape, and a repeat is ignored', () => {
  const { requirements } = loadRequirements(
    projectWith({
      'a.md': `---\nid: A-1\ntitle: T\n---\n- **AC-1**: bullet form\n**AC-2** bare line\n1. **AC-1** — repeated\n`,
    }),
  );

  assert.deepEqual(
    requirements[0].criteria.map(criterion => [criterion.id, criterion.text]),
    [
      ['AC-1', 'bullet form'],
      ['AC-2', 'bare line'],
    ],
  );
});

test('a file with no frontmatter is a problem, not a silent skip', () => {
  const { requirements, problems } = loadRequirements(projectWith({ 'a.md': '# just prose\n' }));

  assert.deepEqual(requirements, []);
  assert.match(problems[0].reason, /no --- frontmatter/);
});

test('an unknown frontmatter key is refused by name', () => {
  const { problems } = loadRequirements(
    projectWith({ 'a.md': '---\nid: A-1\ntitle: T\nstatuss: valid\n---\n' }),
  );

  assert.match(problems[0].reason, /unknown frontmatter key "statuss"/);
});

test('nested or list frontmatter is refused rather than half-read', () => {
  // A KNOWN key with a nested value: an unknown key is caught earlier and by name, which is the more
  // specific message — both paths are refusals, and this asserts the one an unknown key cannot reach.
  const { problems } = loadRequirements(
    projectWith({ 'a.md': '---\nid: A-1\ntitle: T\nparent:\n  - one\n---\n' }),
  );

  assert.match(problems[0].reason, /nested or list frontmatter/);
});

test('an invalid status names the allowed values', () => {
  const { problems } = loadRequirements(
    projectWith({ 'a.md': '---\nid: A-1\ntitle: T\nstatus: probably\n---\n' }),
  );

  assert.match(problems[0].reason, /status "probably" — one of valid, draft/);
});

test('a missing id or title is a problem', () => {
  const noId = loadRequirements(projectWith({ 'a.md': '---\ntitle: T\n---\n' }));
  assert.match(noId.problems[0].reason, /no id/);

  const noTitle = loadRequirements(projectWith({ 'a.md': '---\nid: A-1\n---\n' }));
  assert.match(noTitle.problems[0].reason, /A-1 has no title/);
});

test('a duplicate id is refused on the second file, naming the first', () => {
  const { requirements, problems } = loadRequirements(
    projectWith({
      'a.md': '---\nid: A-1\ntitle: First\n---\n',
      'b.md': '---\nid: A-1\ntitle: Second\n---\n',
    }),
  );

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].title, 'First');
  assert.match(problems[0].reason, /duplicate id A-1 — already defined in requirements\/a\.md/);
});

test('a parent nobody defines is a problem, but the requirement still loads', () => {
  const { requirements, problems } = loadRequirements(
    projectWith({ 'a.md': '---\nid: A-1\ntitle: T\nparent: NOPE-9\n---\n' }),
  );

  assert.equal(requirements.length, 1);
  assert.match(problems[0].reason, /names parent NOPE-9, which no file defines/);
});

test('quotes and trailing comments are stripped from a value', () => {
  const { requirements } = loadRequirements(
    projectWith({ 'a.md': '---\nid: \'A-1\'\ntitle: "T"  # a note\n---\n' }),
  );

  assert.equal(requirements[0].id, 'A-1');
  assert.equal(requirements[0].title, 'T');
});

test('requirements nest in subdirectories, and files are read in a stable order', () => {
  const { requirements } = loadRequirements(
    projectWith({
      'z.md': '---\nid: Z-1\ntitle: Z\n---\n',
      'payments/a.md': '---\nid: A-1\ntitle: A\n---\n',
    }),
  );

  assert.deepEqual(
    requirements.map(item => item.file),
    ['requirements/payments/a.md', 'requirements/z.md'],
  );
});

test('a project with no requirements directory is empty, not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-req-'));
  dirs.push(dir);

  assert.deepEqual(loadRequirements(dir), { requirements: [], problems: [] });
});
