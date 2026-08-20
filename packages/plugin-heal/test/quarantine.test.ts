/**
 * Quarantine: loading, shielding, and the gates.
 *
 * The load-bearing assertion is **fail open** — a malformed file must disable shielding without
 * throwing, and must never turn a pass into a failure either. A quarantine mechanism that can break
 * a run is worse than no quarantine mechanism.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  EMPTY_QUARANTINE,
  loadQuarantine,
  QUARANTINE_PATH,
  saveQuarantine,
  type QuarantineEntry,
} from '../src/quarantine/file.js';
import { GATE_DEFAULTS, gateQuarantine } from '../src/quarantine/gate.js';
import { daysLeft, decideShield, isExpired, isShielded } from '../src/quarantine/shield.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-20T12:00:00.000Z');

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-heal-q-'));
  dirs.push(dir);
  return dir;
};

function entry(over: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    testKey: 'aaaaaaaaaaaaaaaa',
    project: 'chromium',
    file: 'tests/a.spec.ts',
    title: 'shows the total',
    class: 'flaky',
    reason: 'races with the cart badge',
    addedAt: new Date(NOW - 2 * DAY).toISOString(),
    expiresAt: new Date(NOW + 5 * DAY).toISOString(),
    addedBy: 'ada@example.com',
    issue: 'https://example.com/issues/4412',
    evidence: { flakeRate: 0.3, runs: 20 },
    ...over,
  };
}

// --- loading ---------------------------------------------------------------------------------

test('an absent file is an empty list with nothing to report', () => {
  const loaded = loadQuarantine(tmp());
  assert.deepEqual(loaded.file, EMPTY_QUARANTINE);
  assert.equal(loaded.problem, undefined);
});

test('malformed JSON disables shielding and says so, without throwing', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'heal'), { recursive: true });
  fs.writeFileSync(path.join(dir, QUARANTINE_PATH), 'not json at all');

  const loaded = loadQuarantine(dir);
  assert.deepEqual(loaded.file.entries, [], 'fail open: no entries means no shielding');
  assert.match(loaded.problem ?? '', /not valid JSON/);
  assert.match(loaded.problem ?? '', /shielding is off/);
});

test('an entry of the wrong shape is dropped and counted, not fatal', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'heal'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, QUARANTINE_PATH),
    JSON.stringify({
      version: 1,
      entries: [
        entry(),
        { testKey: 'x' },
        { ...entry(), class: 'true-fail' },
        { ...entry(), expiresAt: 'not a date' },
      ],
    }),
  );
  const loaded = loadQuarantine(dir);
  assert.equal(loaded.file.entries.length, 1, 'only the well-formed entry survives');
  assert.match(loaded.problem ?? '', /ignored 3 malformed entries/);
});

test('a round trip preserves entries and sorts them stably', () => {
  const dir = tmp();
  saveQuarantine(dir, {
    version: 1,
    entries: [entry({ testKey: 'bbbb', title: 'b' }), entry({ testKey: 'aaaa', title: 'a' })],
  });
  assert.deepEqual(
    loadQuarantine(dir).file.entries.map(item => item.testKey),
    ['aaaa', 'bbbb'],
  );
});

// --- shielding -------------------------------------------------------------------------------

test('expiry at exactly expiresAt is expired, not shielded', () => {
  const exact = entry({ expiresAt: new Date(NOW).toISOString() });
  assert.equal(isExpired(exact, NOW), true);
  assert.equal(isShielded(exact, NOW), false);
  assert.equal(isShielded(entry({ expiresAt: new Date(NOW + 1).toISOString() }), NOW), true);
});

test('daysLeft counts down and goes negative once expired', () => {
  assert.equal(daysLeft(entry(), NOW), 5);
  assert.equal(daysLeft(entry({ expiresAt: new Date(NOW - DAY).toISOString() }), NOW), -1);
});

test('every failure covered by a live entry shields the run', () => {
  const decision = decideShield(['aaaaaaaaaaaaaaaa'], [entry()], NOW);
  assert.equal(decision.shield, true);
  assert.equal(decision.used.length, 1);
  assert.deepEqual(decision.unshielded, []);
});

test('one uncovered failure keeps the run red', () => {
  const decision = decideShield(['aaaaaaaaaaaaaaaa', 'unlisted-key'], [entry()], NOW);
  assert.equal(decision.shield, false);
  assert.deepEqual(decision.unshielded, ['unlisted-key']);
  assert.equal(decision.used.length, 1, 'the covered one is still reported as covered');
});

test('an expired entry does not shield, and is reported separately', () => {
  const stale = entry({ expiresAt: new Date(NOW - DAY).toISOString() });
  const decision = decideShield(['aaaaaaaaaaaaaaaa'], [stale], NOW);
  assert.equal(decision.shield, false);
  assert.deepEqual(decision.expired, [stale]);
  assert.deepEqual(decision.unshielded, ['aaaaaaaaaaaaaaaa']);
});

test('no failures means no shield — there is nothing to suppress', () => {
  const decision = decideShield([], [entry()], NOW);
  assert.equal(decision.shield, false, 'claiming a shield on a green run would be a lie');
});

// --- gates -----------------------------------------------------------------------------------

const gate = (entries: QuarantineEntry[], over = {}) =>
  gateQuarantine({ entries, now: NOW, ...over });

test('a healthy list passes every gate', () => {
  const result = gate([entry()]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.quarantineDays, 7, 'added 2 days ago, expires in 5');
});

test('an expired entry fails the gate and is named', () => {
  const result = gate([entry({ expiresAt: new Date(NOW - DAY).toISOString() })]);
  assert.equal(result.ok, false);
  const violation = result.violations.find(item => item.gate === 'expired');
  assert.ok(violation);
  assert.deepEqual(violation.entries, ['[chromium] shows the total']);
});

test('the size budget fires independently of everything else', () => {
  const many = Array.from({ length: GATE_DEFAULTS.maxEntries + 1 }, (_, i) =>
    entry({ testKey: `key-${i}`, title: `test ${i}` }),
  );
  const gates = gate(many).violations.map(item => item.gate);
  assert.ok(gates.includes('max-entries'));
});

test('the share budget needs a suite size, and fires only with one', () => {
  const two = [entry({ testKey: 'a' }), entry({ testKey: 'b' })];
  assert.equal(
    gate(two).violations.some(item => item.gate === 'max-share'),
    false,
    'without totalTests the share gate cannot be evaluated',
  );
  assert.ok(gate(two, { totalTests: 20 }).violations.some(item => item.gate === 'max-share'));
  assert.equal(
    gate(two, { totalTests: 400 }).violations.some(item => item.gate === 'max-share'),
    false,
  );
});

test('a TTL longer than the maximum is TTL laundering and fails', () => {
  const long = entry({ expiresAt: new Date(NOW + 60 * DAY).toISOString() });
  assert.ok(gate([long]).violations.some(item => item.gate === 'max-ttl'));
});

test('an old entry with no issue fails, a fresh one does not', () => {
  const old = entry({ addedAt: new Date(NOW - 10 * DAY).toISOString(), issue: undefined });
  const fresh = entry({ addedAt: new Date(NOW - DAY).toISOString(), issue: undefined });
  assert.ok(gate([old]).violations.some(item => item.gate === 'missing-issue'));
  assert.equal(
    gate([fresh]).violations.some(item => item.gate === 'missing-issue'),
    false,
  );
});

test('an entry with no measured evidence is a deterministic failure wearing the word flaky', () => {
  assert.ok(
    gate([entry({ evidence: undefined })]).violations.some(v => v.gate === 'weak-evidence'),
  );
  assert.ok(
    gate([entry({ evidence: { flakeRate: 0.01, runs: 40 } })]).violations.some(
      v => v.gate === 'weak-evidence',
    ),
  );
  assert.ok(
    gate([entry({ evidence: { flakeRate: 0.5, runs: 3 } })]).violations.some(
      v => v.gate === 'weak-evidence',
    ),
    'a high rate over three runs is not a measurement',
  );
});

test('the ratchet allows shrinking and refuses growth', () => {
  const before = [entry({ testKey: 'a', title: 'a' })];
  const grown = [...before, entry({ testKey: 'b', title: 'b' })];

  const growing = gate(grown, { previous: before });
  const ratchet = growing.violations.find(item => item.gate === 'ratchet');
  assert.ok(ratchet, 'growth needs a reason in the PR');
  assert.deepEqual(ratchet.entries, ['[chromium] b'], 'it names what was added');

  assert.equal(
    gate(before, { previous: grown }).violations.some(item => item.gate === 'ratchet'),
    false,
    'the list may shrink freely',
  );
  assert.equal(
    gate(before, { previous: before }).violations.some(item => item.gate === 'ratchet'),
    false,
  );
});

test('with no previous list the ratchet is skipped rather than guessed at', () => {
  assert.equal(
    gate([entry()]).violations.some(item => item.gate === 'ratchet'),
    false,
  );
});
