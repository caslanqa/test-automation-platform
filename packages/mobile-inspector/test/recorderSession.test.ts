/**
 * End-to-end recording-engine tests, driven by the scripted fake driver and a real temporary project.
 *
 * This is the loop the whole product exists for — connect, tap, generate, save, run — and until the fake
 * driver existed none of it could be exercised without an emulator. Every assertion below corresponds to
 * a defect the audit found: the generated header missing `platform`/`appId`, a tap recorded as a fragile
 * coordinate instead of the button's accessibility id, a save landing on the wrong extension, and a run
 * that never named a project or set its gate variable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { ClientMessage, ServerMessage } from '../src/service/protocol.js';
import { RecorderSession } from '../src/service/recorderSession.js';
import { fakeDriverMap, type FakeDriver } from './fakes/fakeDriver.js';

/** Centre of the login button in the fake's login screen (bounds x20 y200 w360 h60). */
const LOGIN_BUTTON = { x: 200, y: 230 };

interface Harness {
  session: RecorderSession;
  driver: FakeDriver;
  events: ServerMessage[];
  dir: string;
  send: (message: ClientMessage) => Promise<void>;
  last: <T extends ServerMessage['type']>(
    type: T,
  ) => Extract<ServerMessage, { type: T }> | undefined;
  code: () => string;
  /** Every `log` message the engine emitted, for asserting that failures are surfaced. */
  logs: () => string[];
}

/**
 * Every session built here, closed at the end of the file. `close()` is idempotent, so the explicit close
 * each test ends with still stands — this only covers the case where an assertion throws first, which used
 * to leave a connected session polling in the background and perturb the tests that followed.
 */
const built: RecorderSession[] = [];
after(async () => {
  await Promise.all(built.map(session => session.close()));
});

/** A temp project with a stubbed Playwright CLI, plus a session wired to the fake driver. */
function harness(options?: Parameters<typeof fakeDriverMap>[0]): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-recorder-'));
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  // Stands in for the project's Playwright: echoes how it was invoked so the test can assert the argv and
  // the gate variable, then exits 0.
  const stub = path.join(bin, 'playwright');
  fs.writeFileSync(stub, '#!/bin/sh\necho "ARGS: $*"\necho "FAKE_GATE: ${FAKE:-unset}"\nexit 0\n');
  fs.chmodSync(stub, 0o755);

  const { map, driver } = fakeDriverMap(options);
  const events: ServerMessage[] = [];
  const session = new RecorderSession(dir, message => events.push(message), map);
  built.push(session);

  return {
    session,
    driver,
    events,
    dir,
    send: message => session.dispatch(message),
    last: type =>
      [...events]
        .reverse()
        .find((e): e is Extract<ServerMessage, { type: typeof type }> => e.type === type),
    code: () => {
      const message = [...events].reverse().find(e => e.type === 'code');
      return message?.type === 'code' ? message.source : '';
    },
    logs: () => events.flatMap(e => (e.type === 'log' ? [e.message] : [])),
  };
}

/**
 * The run child is spawned asynchronously, so its completion arrives as an event. Bounded on purpose: a
 * regression that never finishes must fail this test quickly rather than hang CI forever.
 */
async function waitForRunToFinish(h: Harness, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const finished = h.events.some(e => e.type === 'runStatus' && e.state === 'finished');
    if (finished) {
      return;
    }
    if (Date.now() >= deadline) {
      const seen = h.events.map(e => e.type).join(', ');
      assert.fail(`the run never finished within ${timeoutMs}ms; events seen: ${seen}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const connect = (h: Harness): Promise<void> =>
  h.send({
    type: 'connect',
    driver: 'fake',
    options: { platform: 'android', device: 'Pixel_7_API_34', appId: 'com.example.app' },
  });

test('connecting reports the device, the hierarchy, a frame and an initial draft', async () => {
  const h = harness();
  await connect(h);

  assert.equal(h.last('connected')?.device.name, 'Pixel_7_API_34');
  assert.ok((h.last('hierarchy')?.nodes.length ?? 0) > 0);
  assert.equal(h.last('frame')?.frame.width, 400);
  assert.match(h.code(), /^import \{ test, expect \} from '@fixtures';/);

  await h.session.close();
});

test('the generated header carries driver, platform, stable device name and appId', async () => {
  const h = harness();
  await connect(h);

  const code = h.code();
  assert.match(code, /driver: "fake"/);
  assert.match(code, /platform: "android"/);
  assert.match(code, /appId: "com\.example\.app"/);
  // The AVD name, never the adb serial the driver also exposes as `device.id` (ADR-003).
  assert.match(code, /device: "Pixel_7_API_34"/);
  assert.doesNotMatch(code, /emulator-5554/, 'an ephemeral serial must never be baked into a test');

  await h.session.close();
});

test('codegen pins the app the session is scoped to, even when the user named none', async () => {
  // Found in the field: connecting the Maestro driver with an empty app id produced a session that showed the
  // screen and refused every interaction, because Maestro scopes every command to one app. The driver now
  // adopts whatever is in the foreground, and the recording has to pin THAT — a test pinning nothing would
  // launch nothing on replay and record against whatever happened to be open.
  const h = harness({ adoptedAppId: 'com.adopted.app' });

  await h.send({ type: 'connect', driver: 'fake', options: { platform: 'android' } });

  assert.equal(h.driver.connects.at(-1)?.appId, undefined, 'the user named no app');
  assert.match(
    h.code(),
    /appId: "com\.adopted\.app"/,
    'the recording pins the one actually in use',
  );

  await h.session.close();
});

test('appId and appSource reach the driver instead of being dropped', async () => {
  const h = harness();
  fs.mkdirSync(path.join(h.dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'build/app.apk'), 'artifact');

  await h.send({
    type: 'connect',
    driver: 'fake',
    options: { platform: 'android', appId: 'com.example.app', appSource: './build/app.apk' },
  });

  assert.equal(h.driver.connects.at(-1)?.appId, 'com.example.app');
  assert.equal(
    h.driver.connects.at(-1)?.appSource,
    path.join(h.dir, 'build/app.apk'),
    'the adapter gets an absolute path so it never has to guess the base directory',
  );
  assert.match(
    h.code(),
    /appSource: "\.\/build\/app\.apk"/,
    'the generated test keeps the path as typed — an absolute one would only work on this machine',
  );

  await h.session.close();
});

test('an app artifact that does not exist is refused instead of reaching the driver', async () => {
  const h = harness();

  await h.send({
    type: 'connect',
    driver: 'fake',
    options: { platform: 'android', appSource: './build/missing.apk' },
  });

  assert.match(h.last('error')?.message ?? '', /not found/);
  assert.deepEqual(h.driver.connects, [], 'ADR-010: validate before an installer sees it');

  await h.session.close();
});

test('the UI is told what the SESSION can do, not what the driver declared', async () => {
  // Found by auditing the adapters: the Appium driver declares `back: true` because its declaration is made
  // before a platform is known, then throws `"back" has no iOS equivalent` on iOS — so the UI offered a button
  // that always failed and the fixture's support check passed. A session knows its platform and may narrow it.
  const h = harness({
    sessionCapabilities: {
      hierarchy: true,
      liveFrames: true,
      gestures: { tap: true, back: false },
    },
  });

  await connect(h);

  assert.equal(h.driver.capabilities.gestures.back, true, 'the driver still declares it broadly');
  assert.equal(
    h.last('connected')?.capabilities.gestures.back,
    false,
    'but the UI must gate on what this session can actually do',
  );

  await h.session.close();
});

test('tapping the login button records its accessibility id, not a coordinate', async () => {
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;

  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });

  assert.deepEqual(h.last('timeline')?.actions, [
    { kind: 'tap', locator: { accessibilityId: 'loginButton', label: 'loginButton' } },
  ]);
  assert.match(h.code(), /await mobileApp\.tap\(\{ accessibilityId: "loginButton" \}\)/);
  // The tap landed on an anonymous inner view too; hit-testing must still prefer the identified parent.
  assert.doesNotMatch(h.code(), /point:/);

  await h.session.close();
});

test('the code appears before the driver answers, not after', async () => {
  // Measured on a device: a Maestro tap takes ~1.3 s of its own, so waiting for it before showing anything
  // put the generated code 1.4 s behind the click and the recorder felt broken. The hit-test is local, so
  // the recording does not need the device to answer first — it needs to be taken back if the device says no.
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;
  const mark = h.events.length;

  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });

  const since = h.events.slice(mark).map(e => e.type);
  assert.ok(
    since.indexOf('timeline') < since.indexOf('actionResult'),
    `the timeline must be sent before the driver's result; saw ${since.join(', ')}`,
  );
  assert.ok(since.indexOf('code') < since.indexOf('actionResult'), 'and so must the code');

  await h.session.close();
});

test('a refused action is taken back out of the timeline it was already in', async () => {
  const h = harness();
  await connect(h);
  const driverSession = h.driver.session;
  assert.ok(driverSession);
  driverSession.failNextAction = 'element went away';
  const mark = h.events.length;

  await h.send({ type: 'perform', action: { kind: 'tap', locator: { text: 'Log in' } } });

  const timelines = h.events
    .slice(mark)
    .flatMap(e => (e.type === 'timeline' ? [e.actions.length] : []));
  assert.deepEqual(timelines, [1, 0], 'recorded optimistically, then retracted');
  assert.deepEqual(h.last('timeline')?.actions, [], 'nothing that did not happen may survive');
  assert.match(h.logs().join('\n'), /element went away/);

  await h.session.close();
});

test('retraction removes the refused action, not whatever happens to be last', async () => {
  // The device can take a second or two to refuse, and the user may edit the timeline in the meantime, so
  // the retraction is by identity rather than by position.
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;
  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });
  const driverSession = h.driver.session;
  assert.ok(driverSession);
  driverSession.failNextAction = 'element went away';

  await h.send({ type: 'perform', action: { kind: 'back' } });

  const actions = h.last('timeline')?.actions ?? [];
  assert.equal(actions.length, 1, 'only the refused action is gone');
  assert.equal(actions[0]?.kind, 'tap', 'the earlier, successful action survives');

  await h.session.close();
});

test('the device is driven by coordinate while the element is what gets recorded', async () => {
  // Measured on a device: asking Maestro to find the element we just hit-tested locally costs ~800 ms per
  // tap, and it is the whole difference between this and Maestro Studio. So the driver is told where to tap
  // and the recording still names the element — which is the artifact that has to survive.
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;

  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });

  const taps = h.driver.session?.performed.filter(a => a.kind === 'tap') ?? [];
  assert.equal(taps.length, 1);
  assert.deepEqual(
    taps[0].kind === 'tap' ? taps[0].locator : undefined,
    { point: LOGIN_BUTTON },
    'the device gets the coordinate the user clicked',
  );
  assert.deepEqual(
    h.last('timeline')?.actions,
    [{ kind: 'tap', locator: { accessibilityId: 'loginButton', label: 'loginButton' } }],
    'the recording names the element, not the coordinate',
  );

  await h.session.close();
});

test('a locator chosen from the menu is performed as chosen, not as a coordinate', async () => {
  // The substitution belongs to the device click only. Picking a candidate from the right-click menu IS the
  // user choosing a locator, so that is what must be exercised.
  const h = harness();
  await connect(h);

  await h.send({ type: 'perform', action: { kind: 'tap', locator: { text: 'Log in' } } });

  const taps = h.driver.session?.performed.filter(a => a.kind === 'tap') ?? [];
  assert.deepEqual(taps[0].kind === 'tap' ? taps[0].locator : undefined, { text: 'Log in' });

  await h.session.close();
});

test('each locator strategy is proven on the driver once, after the screen settles', async () => {
  // Driving by coordinate stops proving that the recorded locator resolves, so the strategy is sampled
  // instead — systematic bugs (an iOS text locator reading `value` while the selector matched `label`) show
  // up on the first sample. Off the critical path: it runs after the action, never before it.
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;

  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });
  const afterFirst = h.driver.session?.performed.filter(a => a.kind === 'isVisible').length ?? 0;
  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });
  const afterSecond = h.driver.session?.performed.filter(a => a.kind === 'isVisible').length ?? 0;

  assert.equal(afterFirst, 1, 'the accessibilityId strategy is sampled once');
  assert.equal(afterSecond, 1, 'and not again for the same strategy');

  await h.session.close();
});

test('a failed action is reported and NOT recorded', async () => {
  const h = harness();
  await connect(h);
  const driverSession = h.driver.session;
  assert.ok(driverSession, 'connect should have handed out a session');
  driverSession.failNextAction = 'element went away';

  await h.send({ type: 'perform', action: { kind: 'tap', locator: { text: 'Log in' } } });

  assert.equal(h.last('actionResult')?.result.ok, false);
  assert.deepEqual(h.last('timeline')?.actions, [], 'a failed action must not enter the timeline');
  assert.match(
    h.logs().join('\n'),
    /element went away/,
    'the failure must be surfaced, not swallowed',
  );

  await h.session.close();
});

test('inspectAt returns ranked locator candidates without performing anything', async () => {
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;

  await h.send({ type: 'inspectAt', ...LOGIN_BUTTON, frameId });

  const inspected = h.last('inspected');
  assert.equal(inspected?.node?.accessibilityId, 'loginButton');
  assert.equal(inspected?.candidates[0]?.strategy, 'accessibilityId');
  assert.equal(h.driver.session?.performed.length, 0, 'inspecting must not touch the device');

  await h.session.close();
});

test('undo and redo move along the recorded timeline', async () => {
  const h = harness();
  await connect(h);
  await h.send({ type: 'perform', action: { kind: 'back' } });
  assert.equal(h.last('timeline')?.actions.length, 1);

  await h.send({ type: 'undo' });
  assert.equal(h.last('timeline')?.actions.length, 0);

  await h.send({ type: 'redo' });
  assert.equal(h.last('timeline')?.actions.length, 1);

  await h.session.close();
});

test('a hand edit survives, and a later recorded action is spliced into it', async () => {
  const h = harness();
  await connect(h);
  const revision = h.last('code')?.revision ?? 0;

  await h.send({
    type: 'editCode',
    revision,
    source: "import { test, expect } from '@fixtures';\n\ntest('mine', async () => {\n});\n",
  });
  assert.match(h.code(), /test\('mine'/);

  await h.send({ type: 'perform', action: { kind: 'back' } });

  const code = h.code();
  assert.match(code, /test\('mine'/, 'the hand-written draft must not be regenerated away');
  assert.match(code, /await mobileApp\.back\(\)/, 'the new action must still appear');

  await h.session.close();
});

test('disconnecting does not throw away the recorded draft or timeline', async () => {
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;
  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });
  const recorded = h.code();

  await h.send({ type: 'disconnect' });

  assert.equal(h.last('disconnected')?.type, 'disconnected');
  assert.equal(h.code(), recorded, 'a disconnect must not cost the user their recording');

  await h.session.close();
});

test('saving writes the driver’s extension, formatted, inside the project', async () => {
  const h = harness();
  await connect(h);
  const frameId = h.last('frame')?.frame.frameId ?? 0;
  await h.send({ type: 'tapAt', ...LOGIN_BUTTON, frameId });

  await h.send({
    type: 'save',
    mode: 'new',
    targetPath: 'tests/login',
    testName: 'login flow',
    source: h.code(),
  });

  const saved = h.last('saved')?.path ?? '';
  assert.ok(saved.endsWith(path.join('tests', 'login.fake.ts')), `unexpected path: ${saved}`);
  const written = fs.readFileSync(saved, 'utf8');
  assert.match(written, /mobileApp\.tap/);
  assert.match(written, /mobileTarget: \{/);

  await h.session.close();
});

test('saving refuses to overwrite an existing file', async () => {
  const h = harness();
  await connect(h);
  const args = {
    type: 'save' as const,
    mode: 'new' as const,
    targetPath: 'tests/dupe',
    testName: 't',
    source: h.code(),
  };
  await h.send(args);
  await h.send(args);

  assert.match(h.last('error')?.message ?? '', /already exists/);

  await h.session.close();
});

test('saving cannot escape the project root', async () => {
  const h = harness();
  await connect(h);

  await h.send({
    type: 'save',
    mode: 'new',
    targetPath: '../../../../etc/pwtap-escape',
    testName: 't',
    source: h.code(),
  });

  assert.match(h.last('error')?.message ?? '', /inside the project/);

  await h.session.close();
});

test('listing test files finds every driver extension', async () => {
  const h = harness();
  await connect(h);
  const testsDir = path.join(h.dir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(path.join(testsDir, 'a.fake.ts'), '');
  fs.writeFileSync(path.join(testsDir, 'b.spec.ts'), '');

  await h.send({ type: 'listTestFiles' });

  const found = h.last('testFiles')?.files.map(f => f.relativePath) ?? [];
  assert.deepEqual(found, ['tests/a.fake.ts'], 'only driver-owned extensions belong in the picker');

  await h.session.close();
});

test('running spawns Playwright with the driver’s project and gate variable', async () => {
  const h = harness();
  await connect(h);

  await h.send({ type: 'run', source: h.code() });
  await waitForRunToFinish(h);

  const output = h.events
    .filter(e => e.type === 'runOutput')
    .map(e => (e.type === 'runOutput' ? e.chunk : ''))
    .join('');
  assert.match(output, /--project=fake/, 'without --project the test runs in the browser project');
  assert.match(output, /FAKE_GATE: 1/, 'without the gate variable the project does not exist');
  assert.match(output, /run-\d+\.fake\.ts/, 'the temp file must match the project’s testMatch');
  assert.equal(h.last('runStatus')?.exitCode, 0);

  // Removed by the time `finished` is announced, not merely eventually. The removal used to be fired off
  // unawaited, so this assertion failed only under load — a real ordering bug wearing a flaky test's clothes.
  const runDir = path.join(h.dir, 'tests', '__inspector__');
  assert.deepEqual(
    fs.existsSync(runDir) ? fs.readdirSync(runDir) : [],
    [],
    'a client told the run finished must be able to trust the cleanup happened',
  );

  await h.session.close();
});

test('a connect failure is reported without leaving a half-open session', async () => {
  const h = harness({ failConnect: 'no device available' });

  await connect(h);

  assert.match(h.last('error')?.message ?? '', /no device available/);
  assert.equal(h.last('connected'), undefined);

  await h.session.close();
});

test('closing the session closes the driver session underneath it', async () => {
  const h = harness();
  await connect(h);
  const driverSession = h.driver.session;

  await h.session.close();

  assert.equal(driverSession?.closed, true, 'a closed window must never leak a device lock');
});
