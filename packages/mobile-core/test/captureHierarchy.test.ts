/**
 * The failure capture, which is what makes mobile healing possible without a device.
 *
 * Playwright writes an `error-context` attachment carrying an ARIA snapshot when a web test fails, and
 * that file is what lets tooling reason about a moved element after the run is over. Mobile had no
 * equivalent: the driver session — the only thing that can answer — is closed in the fixture's teardown.
 * So the fixture captures one first.
 *
 * Everything worth asserting here is about restraint. It must not run on a green test, must not run
 * against a driver that has no tree to give, and must never turn a failing test's real reason into an
 * error of its own. The device side of it — that a real driver returns a usable hierarchy — is already
 * covered by `mobile-inspector`'s device test; what is new is the decision to call it at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { captureHierarchyOnFailure } from '../src/fixture.js';
import type { DriverSession, MobileNode } from '../src/types.js';

const tree: MobileNode[] = [
  { text: 'Welcome', children: [{ accessibilityId: 'loginButton', text: 'Log in' }] },
];

function fakeSession(over: Partial<DriverSession> = {}): DriverSession {
  return {
    driverId: 'maestro',
    inspectHierarchy: async () => tree,
    close: async () => undefined,
    ...over,
  } as DriverSession;
}

function fakeTestInfo(status: string, expectedStatus = 'passed') {
  const attachments: Array<{ name: string; body?: Buffer; contentType?: string }> = [];
  return {
    status,
    expectedStatus,
    attachments,
    attach: async (name: string, options: { body?: Buffer; contentType?: string }) => {
      attachments.push({ name, ...options });
    },
  };
}

test('a failing test gets its screen recorded', async () => {
  const info = fakeTestInfo('failed');
  await captureHierarchyOnFailure(fakeSession(), true, info);

  assert.equal(info.attachments.length, 1);
  assert.equal(info.attachments[0].name, 'mobile-hierarchy');
  assert.equal(info.attachments[0].contentType, 'application/json');

  const payload = JSON.parse(String(info.attachments[0].body)) as {
    driver: string;
    nodes: MobileNode[];
  };
  assert.equal(payload.driver, 'maestro');
  assert.equal(payload.nodes[0].children?.[0].accessibilityId, 'loginButton');
});

test('identity keys are assigned, so a reader can re-resolve a node rather than count positions', () => {
  // ADR-007's whole point: position alone breaks when a list scrolls, identifiers alone are not unique.
  const info = fakeTestInfo('failed');
  return captureHierarchyOnFailure(fakeSession(), true, info).then(() => {
    const payload = JSON.parse(String(info.attachments[0].body)) as { nodes: MobileNode[] };
    assert.ok(typeof payload.nodes[0].key === 'string' && payload.nodes[0].key.length > 0);
    assert.ok(typeof payload.nodes[0].children?.[0].key === 'string');
  });
});

test('a passing test records nothing — the cost on a green run is one comparison', async () => {
  let called = false;
  const session = fakeSession({
    inspectHierarchy: async () => {
      called = true;
      return tree;
    },
  });
  const info = fakeTestInfo('passed');
  await captureHierarchyOnFailure(session, true, info);
  assert.equal(called, false, 'the driver must not be asked anything on a green run');
  assert.equal(info.attachments.length, 0);
});

test('a test that failed as expected is a pass, and records nothing', async () => {
  const info = fakeTestInfo('failed', 'failed');
  await captureHierarchyOnFailure(fakeSession(), true, info);
  assert.equal(info.attachments.length, 0);
});

test('a driver with no hierarchy is not asked for one', async () => {
  let called = false;
  const session = fakeSession({
    inspectHierarchy: async () => {
      called = true;
      return tree;
    },
  });
  await captureHierarchyOnFailure(session, false, fakeTestInfo('failed'));
  assert.equal(called, false);
});

test('a driver that throws does not replace the reason the test actually failed', async () => {
  const session = fakeSession({
    inspectHierarchy: async () => {
      throw new Error('the device went away');
    },
  });
  const info = fakeTestInfo('failed');
  // No rejection: a diagnostic that can fail a run is worse than no diagnostic.
  await captureHierarchyOnFailure(session, true, info);
  assert.equal(info.attachments.length, 0);
});

test('an attachment that cannot be written is swallowed too', async () => {
  const info = {
    status: 'failed',
    expectedStatus: 'passed',
    attach: async () => {
      throw new Error('disk full');
    },
  };
  await captureHierarchyOnFailure(fakeSession(), true, info as never);
});
