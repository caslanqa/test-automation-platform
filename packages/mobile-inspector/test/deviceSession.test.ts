/**
 * Capture scheduling (ADR-006). The old fixed 1500 ms interval both saturated a slow driver and left a fast
 * one feeling stale, and it polled drivers that cannot produce frames cheaply at all.
 *
 * Timings are injected so the whole file runs in milliseconds: waiting out the real 750 ms floor cost the
 * suite eight seconds to assert something a 20 ms floor proves just as well. Counts are asserted as ranges —
 * the point is the cadence, not an exact tick.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { DeviceSession } from '../src/service/deviceSession.js';
import type { RecorderEvent } from '../src/service/protocol.js';
import { FakeDriver } from './fakes/fakeDriver.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Scaled-down timings: same logic, ~40x faster than the production floors. */
const FAST = { settleMs: 5, minPollMs: 20, maxPollMs: 40, maxBackoffMs: 200 };

/**
 * Cleanup runs even when an assertion fails: the idle poll reschedules itself, so a session left connected by
 * a failed test used to keep the runner alive indefinitely.
 */
function harness(t: TestContext): {
  device: DeviceSession;
  frames: () => number;
  events: RecorderEvent[];
} {
  const events: RecorderEvent[] = [];
  const device = new DeviceSession(event => events.push(event), FAST);
  t.after(() => device.disconnect());
  return { device, frames: () => events.filter(e => e.type === 'frame').length, events };
}

test('connecting captures a frame and a hierarchy straight away', async t => {
  const { device, frames, events } = harness(t);

  await device.connect(new FakeDriver(), { platform: 'android' });

  assert.equal(frames(), 1);
  assert.ok(events.some(e => e.type === 'hierarchy'));
  assert.equal(device.connected, true);
});

test('an idle session keeps polling, at a rate a fast driver can sustain', async t => {
  const { device, frames } = harness(t);
  await device.connect(new FakeDriver(), { platform: 'android' });
  const afterConnect = frames();

  await sleep(70); // the fake captures instantly, so the interval clamps to the floor

  const polls = frames() - afterConnect;
  assert.ok(polls >= 2, `expected the idle poll to keep looking, saw ${polls}`);
  assert.ok(
    polls <= 6,
    `expected a bounded rate, saw ${polls} — that would saturate a real device`,
  );
});

test('a driver without cheap frames is never polled', async t => {
  const { device, frames } = harness(t);
  const driver = new FakeDriver();
  // Same shape as a driver that can only screenshot expensively; its screen updates after actions instead.
  (driver as { capabilities: { liveFrames: boolean } }).capabilities = {
    ...driver.capabilities,
    liveFrames: false,
  };
  await device.connect(driver, { platform: 'android' });
  const afterConnect = frames();

  await sleep(60);

  assert.equal(
    frames(),
    afterConnect,
    'polling a driver that declared no live frames wastes the device',
  );
});

test('disconnecting stops the schedule', async t => {
  const { device, frames } = harness(t);
  await device.connect(new FakeDriver(), { platform: 'android' });

  await device.disconnect();
  const afterDisconnect = frames();
  await sleep(60);

  assert.equal(frames(), afterDisconnect, 'a closed device must not keep being captured');
});

test('a settle after an action looks twice when the screen moved', async t => {
  const { device, frames } = harness(t);
  const driver = new FakeDriver();
  await device.connect(driver, { platform: 'android' });
  const afterConnect = frames();

  // The fake advances to the next screen on every successful action, so this settle should see a change.
  await device.perform({ kind: 'back' });
  await device.settle();

  const captured = frames() - afterConnect;
  assert.ok(captured >= 2, `a moving screen deserves a second look, saw ${captured}`);
});

test('a failing capture is reported and backs off instead of hammering', async t => {
  const { device, events, frames } = harness(t);
  const driver = new FakeDriver();
  await device.connect(driver, { platform: 'android' });
  const afterConnect = frames();
  const session = driver.session;
  assert.ok(session);
  session.failCapture = 'device went away';

  await sleep(120);

  const warnings = events.filter(e => e.type === 'log' && e.message.includes('device went away'));
  assert.ok(warnings.length >= 1, 'the failure must be surfaced, not swallowed');
  assert.ok(warnings.length <= 4, `backoff should slow the retries, saw ${warnings.length}`);
  assert.equal(frames(), afterConnect, 'a failed capture emits no frame');
});

test('perform reports a driver failure rather than throwing', async t => {
  const { device } = harness(t);
  const driver = new FakeDriver();
  await device.connect(driver, { platform: 'android' });
  const session = driver.session;
  assert.ok(session);
  session.failNextAction = 'element went away';

  const result = await device.perform({ kind: 'back' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'element went away');
});

test('perform on a disconnected device answers instead of crashing', async t => {
  const { device } = harness(t);

  const result = await device.perform({ kind: 'back' });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not connected/);
});
