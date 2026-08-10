/**
 * Frame storage: the dedup and the two retention policies.
 *
 * Frames are the biggest thing this service moves, so the rules about them are the ones a regression would
 * make expensive rather than merely wrong: an unchanged screen must not be re-sent, a live session must not
 * hold every screenshot it ever took, and a recorded step's screen must survive long enough to be looked at.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ScreenFrame } from '@pwtap/mobile-core';

import { FrameStore } from '../src/service/frameStore.js';

/** A frame whose bytes are determined by `content`, so two frames differ exactly when it does. */
function frame(frameId: number, content: number): ScreenFrame {
  return {
    frameId,
    // A PNG signature, so the store sniffs the content type the way it does for a real capture.
    imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, content]).toString(
      'base64',
    ),
    width: 400,
    height: 800,
    orientation: 'portrait',
    capturedAt: 0,
  };
}

test('an identical screen reports the id the client already has', () => {
  const store = new FrameStore();

  const first = store.accept(frame(0, 1));
  const second = store.accept(frame(1, 1));

  assert.equal(first.kind, 'new');
  assert.deepEqual(
    second,
    { kind: 'unchanged', frameId: 0 },
    'no second copy of the same megabytes',
  );
  assert.equal(store.get(1), undefined, 'and the duplicate is not stored under its own id');
});

test('the rolling window forgets old frames', () => {
  const store = new FrameStore();

  for (let id = 0; id < 6; id += 1) {
    store.accept(frame(id, id));
  }

  assert.equal(store.get(0), undefined, 'a long session must not hold every screenshot it took');
  assert.ok(store.get(5), 'the newest frame is always fetchable');
  assert.equal(store.latest?.frameId, 5);
});

test('a frame a recorded step points at survives the window', () => {
  const store = new FrameStore();
  store.accept(frame(0, 0));

  // What the transport does on every `timeline` event: the recording IS the retention policy.
  store.retainOnly([0]);
  for (let id = 1; id < 6; id += 1) {
    store.accept(frame(id, id));
  }

  assert.ok(store.get(0), 'the step could not be reviewed without the screen it produced');
});

test('a step that is undone or deleted releases its frame', () => {
  const store = new FrameStore();
  store.accept(frame(0, 0));
  store.accept(frame(1, 1));
  store.retainOnly([0, 1]);

  store.retainOnly([0]); // the second step was removed from the timeline
  for (let id = 2; id < 7; id += 1) {
    store.accept(frame(id, id));
  }

  assert.ok(store.get(0), 'the surviving step keeps its frame');
  assert.equal(store.get(1), undefined, 'the removed one lets go of it');
});

test('clearing the store releases retained step frames too', () => {
  const store = new FrameStore();
  store.accept(frame(0, 0));
  store.retainOnly([0]);

  store.clear();

  assert.equal(store.get(0), undefined);
  assert.equal(store.latest, undefined);
});
