/** The flat YAML subset: what it accepts, what it refuses, and that a body survives verbatim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FrontmatterError,
  parseFrontmatter,
  serializeFrontmatter,
} from '../src/agents/frontmatter.js';

const doc = (front: string, body = 'Body line.\n'): string => `---\n${front}\n---\n${body}`;

test('scalars, inline lists and block lists all parse', () => {
  const { data } = parseFrontmatter(
    doc(
      [
        'name: mobile-vv',
        'model: sonnet',
        'tools: [read, search, shell]',
        'owns:',
        '  - mobile-locators',
        '  - device-matrix',
      ].join('\n'),
    ),
    'mobile-vv.md',
  );
  assert.equal(data.name, 'mobile-vv');
  assert.equal(data.model, 'sonnet');
  assert.deepEqual(data.tools, ['read', 'search', 'shell']);
  assert.deepEqual(data.owns, ['mobile-locators', 'device-matrix']);
});

test('a value may contain a colon — only the first one separates', () => {
  const { data } = parseFrontmatter(
    doc('description: Verify mobile coverage: device matrix and locator strategy'),
    'x.md',
  );
  assert.equal(data.description, 'Verify mobile coverage: device matrix and locator strategy');
});

test('the body is returned byte-for-byte, including the blank lines and fences in it', () => {
  const body = '# Heading\n\n```ts\nimport { test } from "@fixtures";\n```\n\n- a\n';
  const { body: parsed } = parseFrontmatter(doc('name: x', body), 'x.md');
  assert.equal(parsed, body);
});

test('a CRLF file parses like an LF one, and keeps CRLF in its body', () => {
  const source = '---\r\nname: x\r\ntools: [read]\r\n---\r\nLine one.\r\nLine two.\r\n';
  const { data, body } = parseFrontmatter(source, 'x.md');
  assert.equal(data.name, 'x');
  assert.deepEqual(data.tools, ['read']);
  assert.equal(body, 'Line one.\r\nLine two.\r\n');
});

test('an empty body is empty, not undefined, even without a trailing newline', () => {
  assert.equal(parseFrontmatter('---\nname: x\n---', 'x.md').body, '');
  assert.equal(parseFrontmatter('---\nname: x\n---\n', 'x.md').body, '');
});

test('comments and blank lines inside the frontmatter are ignored', () => {
  const { data } = parseFrontmatter(
    doc(['# why this exists', '', 'name: x', '', '# and this key', 'model: haiku'].join('\n')),
    'x.md',
  );
  assert.deepEqual(data, { name: 'x', model: 'haiku' });
});

test('quoted scalars are unquoted, in both quote styles', () => {
  const { data } = parseFrontmatter(
    doc(['a: "has: a colon"', "b: 'it''s quoted'", 'c: "tab\\there"'].join('\n')),
    'x.md',
  );
  assert.equal(data.a, 'has: a colon');
  assert.equal(data.b, "it's quoted");
  assert.equal(data.c, 'tab\there');
});

test('a key with nothing after it is an empty list, so a block list can append to it', () => {
  assert.deepEqual(parseFrontmatter(doc('owns:'), 'x.md').data.owns, []);
  assert.deepEqual(parseFrontmatter(doc('tools: []'), 'x.md').data.tools, []);
});

test('a missing opening delimiter throws and names the file', () => {
  assert.throws(
    () => parseFrontmatter('name: x\n---\nbody\n', 'vv-lead.md'),
    (err: unknown) => {
      assert.ok(err instanceof FrontmatterError);
      assert.equal(err.file, 'vv-lead.md');
      assert.match(err.message, /vv-lead\.md: missing opening/);
      return true;
    },
  );
});

test('a missing closing delimiter throws rather than swallowing the whole file', () => {
  assert.throws(
    () => parseFrontmatter('---\nname: x\nbody with no close\n', 'x.md'),
    /missing closing/,
  );
});

test('a line that is neither a key nor a list item throws', () => {
  assert.throws(
    () => parseFrontmatter(doc('name: x\njust prose'), 'x.md'),
    /expected 'key: value'/,
  );
});

test('serialize renders lists inline and round-trips a parse', () => {
  const source = doc(
    ['name: release-gate', 'tools: [read, search]', 'owns: [read-run-artifacts]'].join('\n'),
  );
  const parsed = parseFrontmatter(source, 'x.md');
  assert.equal(serializeFrontmatter(parsed.data, parsed.body), source);
});

test('serialize quotes anything a YAML reader would read as more than a string', () => {
  const rendered = serializeFrontmatter(
    {
      plain: 'mobile-vv',
      colon: 'Verify: this',
      hash: 'budget #1',
      leadingDash: '-not-a-list',
      reserved: 'yes',
      numeric: '42',
      padded: 'trailing ',
      list: ['a, b', 'plain'],
    },
    '',
  );
  assert.match(rendered, /^plain: mobile-vv$/m);
  assert.match(rendered, /^colon: "Verify: this"$/m);
  assert.match(rendered, /^hash: "budget #1"$/m);
  assert.match(rendered, /^leadingDash: "-not-a-list"$/m);
  assert.match(rendered, /^reserved: "yes"$/m);
  assert.match(rendered, /^numeric: "42"$/m);
  assert.match(rendered, /^padded: "trailing "$/m);
  assert.match(rendered, /^list: \["a, b", plain\]$/m);
});

test('every parse case survives a serialize/parse round trip unchanged', () => {
  for (const front of [
    'name: x',
    'description: Verify mobile coverage: device matrix',
    'tools: [read, search, shell]',
    'owns: []',
    'a: "has: a colon"',
    'n: "42"',
  ]) {
    const first = parseFrontmatter(doc(front), 'x.md');
    const second = parseFrontmatter(serializeFrontmatter(first.data, first.body), 'x.md');
    assert.deepEqual(second.data, first.data, front);
    assert.equal(second.body, first.body, front);
  }
});
