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
