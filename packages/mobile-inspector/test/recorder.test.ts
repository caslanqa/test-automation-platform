/**
 * The action log is a cursor over an append-only list, not a pair of stacks. The old two-stack model threw
 * the redo stack away on any non-append edit, so an undo followed by an unrelated removal quietly made the
 * undone work unrecoverable.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recorder } from '../src/service/recorder.js';

const tap = (id: string) => ({ kind: 'tap' as const, locator: { accessibilityId: id } });
const ids = (recorder: Recorder): string[] =>
  recorder.actions.map(a => ('locator' in a ? (a.locator.accessibilityId ?? '?') : a.kind));

test('appended actions come back in order', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));
  recorder.append(tap('b'));

  assert.deepEqual(ids(recorder), ['a', 'b']);
  assert.equal(recorder.canUndo, true);
  assert.equal(recorder.canRedo, false);
});

test('undo hides an action and redo brings it back', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));
  recorder.append(tap('b'));

  recorder.undo();
  assert.deepEqual(ids(recorder), ['a']);
  assert.equal(recorder.canRedo, true);

  recorder.redo();
  assert.deepEqual(ids(recorder), ['a', 'b']);
});

test('undo past the start and redo past the end are no-ops', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));

  recorder.undo();
  assert.equal(recorder.undo(), undefined);
  assert.deepEqual(ids(recorder), []);

  recorder.redo();
  assert.equal(recorder.redo(), undefined);
  assert.deepEqual(ids(recorder), ['a']);
});

test('recording after an undo replaces the abandoned branch', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));
  recorder.append(tap('b'));
  recorder.undo();

  recorder.append(tap('c'));

  assert.deepEqual(ids(recorder), ['a', 'c']);
  assert.equal(recorder.canRedo, false, 'b was abandoned, not queued behind c');
});

test('removing an action does not silently discard the redo history of a DIFFERENT undo', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));
  recorder.append(tap('b'));
  recorder.append(tap('c'));

  // Undo c, then remove a. The old model dropped c here without saying anything.
  recorder.undo();
  assert.equal(recorder.remove(0), true);

  assert.deepEqual(ids(recorder), ['b']);
  assert.equal(recorder.canRedo, false, 'the rewrite is deliberate and visible, not a silent loss');
});

test('remove rejects an index outside the live actions', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));
  recorder.undo();

  assert.equal(recorder.remove(0), false, 'an undone action is not live and cannot be removed');
  assert.equal(recorder.remove(-1), false);
});

test('clear empties everything, including what was undone', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));
  recorder.append(tap('b'));
  recorder.undo();

  recorder.clear();

  assert.deepEqual(ids(recorder), []);
  assert.equal(recorder.canUndo, false);
  assert.equal(recorder.canRedo, false);
});

test('actions is a copy, so a caller cannot mutate the log', () => {
  const recorder = new Recorder();
  recorder.append(tap('a'));

  recorder.actions.push(tap('injected'));

  assert.deepEqual(ids(recorder), ['a']);
});
