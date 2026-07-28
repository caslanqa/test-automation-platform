/**
 * The draft has one writer at a time, and a device event is never that writer — `run` disconnects before it
 * spawns Playwright, so a draft cleared by a disconnect is a draft lost while running the very test it holds.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Draft } from '../src/service/draft.js';

test('a generated draft is replaced on every regeneration, and the revision advances', () => {
  const draft = new Draft();

  assert.equal(
    draft.regenerate(() => 'first'),
    true,
  );
  const after = draft.state;
  assert.equal(after.source, 'first');
  assert.ok(after.revision > 0);

  draft.regenerate(() => 'second');
  assert.equal(draft.state.source, 'second');
  assert.ok(draft.state.revision > after.revision);
});

test('once the user types, regeneration stops overwriting them', () => {
  const draft = new Draft();
  draft.regenerate(() => 'generated');

  assert.equal(draft.takeOver('mine', draft.state.revision), true);
  assert.equal(
    draft.regenerate(() => 'generated again'),
    false,
  );
  assert.equal(draft.state.source, 'mine');
  assert.equal(draft.state.userOwned, true);
});

test('a new action is spliced into a user-owned draft rather than dropped', () => {
  const draft = new Draft();
  draft.takeOver('mine', 0);

  draft.spliceIntoUserDraft(source => `${source}\n// appended`);

  assert.match(draft.state.source, /mine/);
  assert.match(draft.state.source, /appended/);
});

test('an edit based on a stale revision is refused, not applied', () => {
  const draft = new Draft();
  draft.regenerate(() => 'v1');
  const stale = draft.state.revision - 1;

  assert.equal(draft.takeOver('based on something older', stale), false);
  assert.equal(draft.state.source, 'v1');
  assert.equal(draft.state.userOwned, false);
});

test('only a reset gives ownership back — that is what a new connection does', () => {
  const draft = new Draft();
  draft.takeOver('mine', 0);

  draft.reset();

  assert.equal(draft.state.source, '');
  assert.equal(draft.state.userOwned, false);
  assert.equal(
    draft.regenerate(() => 'fresh'),
    true,
  );
});
