/**
 * The Phase 2 exit gate: a scripted 200-interaction run must drop nothing (architecture.md §12).
 *
 * "Dropped" is the failure this whole design guards against, and it has had two distinct causes in this
 * codebase: a frame-staleness check that discarded taps racing the poll timer (ADR-006), and a launch-wide
 * command sequence that refused everything after a reload. Neither shows up in a test that performs one
 * action and asserts on it — they need volume, and they need the frame schedule running underneath.
 *
 * The fake driver advances a screen on every action, so the hierarchy and the frame id genuinely move while
 * the interactions arrive, which is exactly the condition that used to lose them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { ClientMessage, ServerMessage } from '../src/service/protocol.js';
import { RecorderSession } from '../src/service/recorderSession.js';
import { fakeDriverMap } from './fakes/fakeDriver.js';

/** Centre of the fake login button, which every screen in the fake carries. */
const LOGIN_BUTTON = { x: 200, y: 230 };
const INTERACTIONS = 200;

const built: RecorderSession[] = [];
/** Temp projects the sessions were given, removed with them — see {@link harness}. */
const projects: string[] = [];
after(async () => {
  await Promise.all(built.map(session => session.close()));
  for (const dir of projects) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A session with the real engine, the fake driver, and settle delays short enough for 200 rounds. */
function harness(): {
  session: RecorderSession;
  events: ServerMessage[];
  send: (message: ClientMessage) => Promise<void>;
  timeline: () => number;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-load-'));
  projects.push(dir);
  const { map } = fakeDriverMap();
  const events: ServerMessage[] = [];
  const session = new RecorderSession(dir, message => events.push(message), map, {
    settleMs: 1,
    minPollMs: 5,
    maxPollMs: 10,
  });
  built.push(session);
  return {
    session,
    events,
    send: message => session.dispatch(message),
    timeline: () => {
      const last = [...events].reverse().find(e => e.type === 'timeline');
      return last?.type === 'timeline' ? last.entries.length : -1;
    },
  };
}

const connect = (send: (message: ClientMessage) => Promise<void>): Promise<void> =>
  send({
    type: 'connect',
    driver: 'fake',
    options: { platform: 'android', device: 'Pixel_7_API_34', appId: 'com.example.app' },
  });

test(`${INTERACTIONS} interactions in a row drop nothing`, async () => {
  const h = harness();
  await connect(h.send);

  // Deliberately quoting a frame id that is already gone on most of these: the device advances a screen per
  // action, so by design most interactions arrive "stale". Not one of them may be discarded for it (ADR-006).
  for (let i = 0; i < INTERACTIONS; i++) {
    await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId: 0 });
  }

  assert.equal(h.timeline(), INTERACTIONS, 'every interaction must be in the timeline');
  const code = [...h.events].reverse().find(e => e.type === 'code');
  assert.equal(
    code?.type === 'code' ? (code.source.match(/await mobileApp\.tap\(/g) ?? []).length : -1,
    INTERACTIONS,
    'and every one of them must be in the generated code',
  );
  assert.deepEqual(
    h.events.filter(e => e.type === 'error'),
    [],
    'nothing may be reported as an error',
  );

  await h.session.close();
});

test('a mixed script of every recordable kind drops nothing', async () => {
  const h = harness();
  await connect(h.send);

  // One of each, repeated: the kinds take different paths (hit-test, direct perform, declarative record), and
  // a drop in any one of them would hide behind 200 identical taps.
  const script: ClientMessage[] = [];
  while (script.length < INTERACTIONS) {
    script.push(
      { type: 'tapAt', ...LOGIN_BUTTON, frameId: 0 },
      { type: 'perform', action: { kind: 'swipe', direction: 'up' } },
      { type: 'perform', action: { kind: 'back' } },
      { type: 'record', action: { kind: 'assertNotVisible', locator: { text: 'Gone' } } },
    );
  }
  const planned = script.length;

  for (const message of script) {
    await h.send(message);
  }

  assert.equal(h.timeline(), planned, `all ${planned} interactions must survive`);
  await h.session.close();
});

test('undo and redo stay exact across a long recording', async () => {
  // The cursor model exists because the old two-stack version threw away the redo stack on any non-append
  // edit. Over one action that is invisible; over a hundred it corrupts the recording.
  const h = harness();
  await connect(h.send);
  for (let i = 0; i < 100; i++) {
    await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId: 0 });
  }

  for (let i = 0; i < 40; i++) {
    await h.send({ type: 'undo' });
  }
  assert.equal(h.timeline(), 60, 'undo must walk back exactly, without dropping or keeping extra');
  for (let i = 0; i < 40; i++) {
    await h.send({ type: 'redo' });
  }
  assert.equal(h.timeline(), 100, 'and redo must restore every one of them');

  await h.session.close();
});
