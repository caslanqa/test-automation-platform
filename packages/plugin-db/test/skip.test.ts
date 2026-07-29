/**
 * The skip helper prints the reason and still records it.
 *
 * A user reported that a skipped DB test said nothing about why. The reason was never missing — it went into an
 * annotation, which the HTML and JSON reports show and the `list` and `line` reporters do not print at all. So
 * this test pins both halves: the terminal line, which is the part that was absent, and the annotation, which
 * must keep reaching the report.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { skipWithReason } from '../src/skip.js';

test('the reason reaches both the terminal and the annotation', () => {
  const printed: string[] = [];
  const recorded: Array<{ condition: boolean; description: string }> = [];
  const original = console.info;
  console.info = (line: string): void => void printed.push(line);
  try {
    skipWithReason(
      { skip: (condition, description) => void recorded.push({ condition, description }) },
      '[db] could not reach the pg database: connect ECONNREFUSED 127.0.0.1:5432',
    );
  } finally {
    console.info = original;
  }

  assert.equal(printed.length, 1, 'exactly one line, so a skip does not become a wall of text');
  assert.match(printed.join('\n'), /skipped .* could not reach the pg database/);
  assert.deepEqual(recorded, [
    {
      condition: true,
      description: '[db] could not reach the pg database: connect ECONNREFUSED 127.0.0.1:5432',
    },
  ]);
});

test('a driver that answers with a paragraph still gets one line, and the report keeps the rest', () => {
  // Verbatim from a scaffolded project with no `pg` installed: Knex's message plus its require stack.
  const sprawling = [
    'could not create a pg connection: Knex: run',
    '$ npm install pg --save',
    "Cannot find module 'pg'",
    'Require stack:',
    '- /project/node_modules/knex/lib/dialects/postgres/index.js',
  ].join('\n');
  const printed: string[] = [];
  const recorded: string[] = [];
  const original = console.info;
  console.info = (line: string): void => void printed.push(line);
  try {
    skipWithReason({ skip: (_c, description) => void recorded.push(description) }, sprawling);
  } finally {
    console.info = original;
  }

  assert.equal(printed.length, 1);
  assert.ok(!printed[0]?.includes('\n'), 'the terminal line must not carry the require stack');
  assert.match(printed[0] ?? '', /could not create a pg connection.*full reason in the report/);
  assert.deepEqual(recorded, [sprawling], 'the report still gets every line');
});
