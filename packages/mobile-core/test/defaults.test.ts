/**
 * The contract owns the action defaults, and a session may narrow what it can do.
 *
 * Both come from auditing the two adapters. Each was inventing its own default for the options a test left
 * out — `isVisible` waited 2 s on Maestro and 5 s on Appium — so the same test body behaved differently
 * depending on the driver, silently and only under timing. And the capability declaration is made before a
 * platform is known, so the Appium driver had to claim `back: true` and then throw on iOS.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTION_DEFAULTS } from '../src/defaults.js';
import type { DriverCapabilities, DriverSession } from '../src/types.js';

test('a default exists for every option an adapter could otherwise invent', () => {
  // The audit found four such literals across the two adapters; a further one appearing without a home here
  // is how the drift starts again. `scrollUntilVisibleMs` bounds the swipe loop the Appium adapter has to run
  // because it has no primitive for it — exactly the kind of number that would otherwise be a literal inside
  // one adapter and a different literal inside the other.
  assert.deepEqual(Object.keys(ACTION_DEFAULTS).sort(), [
    'isVisibleMs',
    'longPressMs',
    'scrollUntilVisibleMs',
    'swipeDistance',
    'waitForMs',
  ]);
});

test('isVisible is short and waitFor is long, because they are asked different questions', () => {
  // `isVisible` is a branch — a test that expects `false` must not stall on it. `waitFor` is a wait.
  assert.ok(
    ACTION_DEFAULTS.isVisibleMs < ACTION_DEFAULTS.waitForMs,
    'a branch query must not wait as long as an explicit wait',
  );
  assert.equal(ACTION_DEFAULTS.waitForMs, 5_000, "Playwright's own default expect timeout");
});

test('a swipe distance is a fraction, not pixels', () => {
  assert.ok(ACTION_DEFAULTS.swipeDistance > 0 && ACTION_DEFAULTS.swipeDistance <= 1);
});

test('a session may narrow the capabilities the driver declared', () => {
  // Typed as optional so an adapter whose support does not vary by platform simply omits it — which is why
  // this needed no contract bump.
  const narrowed: DriverCapabilities = {
    hierarchy: true,
    liveFrames: true,
    gestures: { tap: true, back: false },
  };
  const session = { capabilities: narrowed } as Partial<DriverSession>;

  assert.equal(session.capabilities?.gestures.back, false);
  assert.equal(({} as Partial<DriverSession>).capabilities, undefined, 'and omitting it is valid');
});
