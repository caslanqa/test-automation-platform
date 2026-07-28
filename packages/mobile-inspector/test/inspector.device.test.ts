/**
 * Device-gated verification against a real emulator/simulator — the Phase 0 exit gate from
 * docs/mobile-inspector/architecture.md §12, automated so it can be re-run instead of clicked through.
 *
 * Every other test in this suite runs against the fake driver. That proves the recording engine and the
 * wiring, but says nothing about whether a real driver returns a usable hierarchy, whether element bounds
 * line up with the screenshot's coordinate space, or whether a recorded locator resolves on a device.
 * This drives the genuine adapter, loaded through the genuine discovery path (`discoverDriverMap`), which
 * nothing else exercises either.
 *
 * OPT-IN — it uses a device and needs the driver's CLI, so it skips unless asked:
 *
 *   PWTAP_DEVICE=1 npm test                                   # maestro, Android, Settings app
 *   PWTAP_DEVICE=1 PWTAP_DEVICE_DRIVER=appium npm test
 *   PWTAP_DEVICE=1 PWTAP_DEVICE_PLATFORM=ios npm test
 *   PWTAP_DEVICE=1 PWTAP_DEVICE_APP=com.example.app npm test
 *
 * It asserts, never mutates: nothing is installed and no device is shut down, so a device you booted
 * yourself is left exactly as you left it. Saves go to a temp directory, never into the repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { MobileNode } from '@pwtap/mobile-core';
import { discoverDriverMap } from '@pwtap/mobile-core';
import type { ServerMessage } from '../src/service/protocol.js';
import { RecorderSession } from '../src/service/recorderSession.js';

/** Repo root — where the workspace links `@pwtap/plugin-*`, i.e. what discovery resolves against. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ENABLED = process.env.PWTAP_DEVICE === '1';
const DRIVER_ID = process.env.PWTAP_DEVICE_DRIVER ?? 'maestro';
const PLATFORM = process.env.PWTAP_DEVICE_PLATFORM === 'ios' ? 'ios' : 'android';
/** The OS Settings app exists on every emulator/simulator, so no build artifact is needed. */
const APP_ID =
  process.env.PWTAP_DEVICE_APP ??
  (PLATFORM === 'android' ? 'com.android.settings' : 'com.apple.Preferences');

/** How stable a node's best identifier is — the order the locator engine itself prefers. */
function identifierRank(node: MobileNode): number {
  if (node.accessibilityId) {
    return 0;
  }
  if (node.resourceId) {
    return 1;
  }
  return node.text ? 2 : 3;
}

/**
 * Pick a realistic tap target: a small, identifiable element — the kind of thing a user actually clicks.
 *
 * Taking "the first node with bounds and an identifier" does not work: on iOS that is
 * `XCUIElementTypeApplication`, the full-screen root, so hit-testing its centre lands on whatever happens
 * to sit in the middle of the screen. The test then passes or fails on the app's current scroll position
 * rather than on anything we control.
 */
function pickTarget(nodes: MobileNode[], screenArea: number): MobileNode | undefined {
  const candidates: MobileNode[] = [];
  const visit = (node: MobileNode): void => {
    const b = node.bounds;
    if (
      b &&
      b.width >= 8 &&
      b.height >= 8 &&
      b.width * b.height <= screenArea * 0.25 &&
      identifierRank(node) < 3
    ) {
      candidates.push(node);
    }
    (node.children ?? []).forEach(visit);
  };
  nodes.forEach(visit);
  const area = (n: MobileNode): number => (n.bounds ? n.bounds.width * n.bounds.height : Infinity);
  return candidates.sort((a, b) => identifierRank(a) - identifierRank(b) || area(a) - area(b))[0];
}

test(`${DRIVER_ID} adapter on a real device: record a tap and generate a runnable test`, async t => {
  if (!ENABLED) {
    t.skip('set PWTAP_DEVICE=1 to run against a real device');
    return;
  }

  // The production discovery path: resolve the plugin's `./inspector` export from node_modules.
  const drivers = await discoverDriverMap(REPO_ROOT);
  const driver = drivers.get(DRIVER_ID);
  if (!driver) {
    t.skip(
      `driver "${DRIVER_ID}" not discoverable (found: ${[...drivers.keys()].join(', ') || 'none'})`,
    );
    return;
  }

  const devices = await driver.discoverDevices();
  const candidate = devices.find(d => d.platform === PLATFORM && d.booted);
  if (!candidate) {
    const seen = devices.map(d => `${d.name}${d.booted ? '(booted)' : ''}`).join(', ');
    t.skip(`no booted ${PLATFORM} device — seen: ${seen || 'none'}`);
    return;
  }

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-device-'));
  const events: ServerMessage[] = [];
  const session = new RecorderSession(projectRoot, message => events.push(message), drivers);
  const last = <T extends ServerMessage['type']>(
    type: T,
  ): Extract<ServerMessage, { type: T }> | undefined =>
    [...events].reverse().find((e): e is Extract<ServerMessage, { type: T }> => e.type === type);
  /** Driver logs and errors, so a failure explains itself instead of just asserting false. */
  const diagnose = (): string =>
    events
      .flatMap(e => (e.type === 'log' || e.type === 'error' ? [`  ${e.type}: ${e.message}`] : []))
      .join('\n');

  try {
    await session.dispatch({
      type: 'connect',
      driver: driver.id,
      options: { platform: PLATFORM, device: candidate.name, headless: false, appId: APP_ID },
    });
    assert.ok(last('connected'), `connect failed:\n${diagnose()}`);

    // 1. A real hierarchy with real bounds.
    const nodes = last('hierarchy')?.nodes ?? [];
    assert.ok(nodes.length > 0, `the device returned an empty hierarchy:\n${diagnose()}`);

    // 2. A real screenshot, sized from the actual image bytes.
    const frame = last('frame')?.frame;
    assert.ok(frame, `no frame captured:\n${diagnose()}`);
    assert.ok(
      frame.width > 0 && frame.height > 0,
      `unreadable screenshot: ${JSON.stringify(frame)}`,
    );

    const target = pickTarget(
      nodes,
      (frame.coordinateWidth ?? frame.width) * (frame.coordinateHeight ?? frame.height),
    );
    assert.ok(target?.bounds, `no small identifiable element on screen:\n${diagnose()}`);

    // 3. Bounds must sit inside the frame's interaction coordinate space. This is the check that catches
    //    the Retina-pixels-vs-logical-points class of bug, where every tap lands on the wrong element.
    const coordWidth = frame.coordinateWidth ?? frame.width;
    const coordHeight = frame.coordinateHeight ?? frame.height;
    assert.ok(
      target.bounds.x >= 0 &&
        target.bounds.y >= 0 &&
        target.bounds.x + target.bounds.width <= coordWidth + 1 &&
        target.bounds.y + target.bounds.height <= coordHeight + 1,
      `bounds ${JSON.stringify(target.bounds)} fall outside the ${coordWidth}x${coordHeight} ` +
        `coordinate space — taps would land off-target`,
    );

    // 4. Hit-test the element's centre and record a tap, exactly as a click in the UI does.
    const centre = {
      x: Math.round(target.bounds.x + target.bounds.width / 2),
      y: Math.round(target.bounds.y + target.bounds.height / 2),
    };
    await session.dispatch({ type: 'inspectAt', ...centre, frameId: frame.frameId });
    const inspected = last('inspected');
    assert.ok(inspected?.node, `hit-testing a real element found nothing:\n${diagnose()}`);
    assert.notEqual(
      inspected.candidates[0]?.strategy,
      'point',
      `only a coordinate locator was offered for an identifiable element: ${JSON.stringify(
        inspected.candidates,
      )}`,
    );

    await session.dispatch({ type: 'tapAt', ...centre, frameId: frame.frameId });
    assert.equal(
      last('actionResult')?.result.ok,
      true,
      `the driver refused a tap on a hit-tested element:\n${diagnose()}`,
    );
    assert.equal(last('timeline')?.actions.length, 1, `the tap was not recorded:\n${diagnose()}`);
    // The recorded locator must be an identifier, not a coordinate: this is the round trip that matters —
    // the engine chose a locator, handed it back to the driver, and the driver resolved it on a real
    // screen. (Asserting the exact element would be wrong: hit-testing an element's centre may legitimately
    // land on a smaller identified child, which is the locator engine working as designed.)
    const recorded = last('timeline')?.actions[0];
    assert.ok(recorded?.kind === 'tap', `unexpected recorded action: ${JSON.stringify(recorded)}`);
    assert.equal(
      recorded.locator.point,
      undefined,
      `an identifiable element was recorded as a coordinate: ${JSON.stringify(recorded.locator)}`,
    );

    // 5. The generated source must be complete enough to replay.
    const code = last('code')?.source ?? '';
    for (const expected of [
      /mobileTarget: \{/,
      new RegExp(`driver: "${DRIVER_ID}"`),
      new RegExp(`platform: "${PLATFORM}"`),
      new RegExp(`appId: "${APP_ID.replace(/\./g, '\\.')}"`),
      /await mobileApp\./,
    ]) {
      assert.match(code, expected, `generated source is incomplete:\n${code}`);
    }

    // 6. And it must land on disk under the driver's own extension.
    await session.dispatch({
      type: 'save',
      mode: 'new',
      targetPath: 'tests/device-check',
      testName: 'device check',
      source: code,
    });
    const saved = last('saved')?.path;
    assert.ok(
      saved?.endsWith(driver.testBinding.extension),
      `save failed or used the wrong extension:\n${diagnose()}`,
    );

    // eslint-disable-next-line no-console
    console.log(`\n[device] ${DRIVER_ID} on ${candidate.name} generated:\n${code}`);
  } finally {
    await session.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
