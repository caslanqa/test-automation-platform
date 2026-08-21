/** Capability predicates: AND across terms, OR inside one, and a typo that fails closed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateRequires, isKnownToken, parseRequires } from '../src/agents/requires.js';

const holds = (raw: string | string[] | undefined, ...tokens: string[]): boolean =>
  evaluateRequires(parseRequires(raw), new Set(tokens));

test('core is always true, and an absent predicate means core', () => {
  assert.equal(holds('core'), true);
  assert.equal(holds(undefined), true);
  assert.equal(holds(''), true);
  assert.equal(holds([]), true);
});

test('a single plugin token follows what is installed', () => {
  assert.equal(holds('plugin:db', 'plugin:db'), true);
  assert.equal(holds('plugin:db', 'plugin:perf'), false);
});

test('| is OR — either mobile plugin satisfies the mobile agents', () => {
  const predicate = 'plugin:appium | plugin:maestro';
  assert.equal(holds(predicate, 'plugin:appium'), true);
  assert.equal(holds(predicate, 'plugin:maestro'), true);
  assert.equal(holds(predicate, 'plugin:appium', 'plugin:maestro'), true);
  assert.equal(holds(predicate), false);
});

test('an array is AND, and so is a comma inside one string', () => {
  assert.equal(holds(['plugin:db', 'cap:ci-github'], 'plugin:db', 'cap:ci-github'), true);
  assert.equal(holds(['plugin:db', 'cap:ci-github'], 'plugin:db'), false);
  assert.equal(holds('plugin:db, cap:ci-github', 'plugin:db', 'cap:ci-github'), true);
  assert.equal(holds('plugin:db, cap:ci-github', 'cap:ci-github'), false);
});

test('! negates a token', () => {
  assert.equal(holds('!plugin:perf'), true);
  assert.equal(holds('!plugin:perf', 'plugin:perf'), false);
  assert.equal(holds(['core', '!plugin:perf'], 'plugin:db'), true);
});

test('an unknown token is false and does not throw — and its negation is false too', () => {
  const seen: string[] = [];
  const evaluate = (raw: string): boolean =>
    evaluateRequires(parseRequires(raw), new Set(['core']), token => seen.push(token));

  assert.equal(evaluate('bogus'), false);
  assert.equal(evaluate('!bogus'), false, 'a typo must not enable a component through negation');
  assert.equal(evaluate('plugin:appium | bogus'), false);
  assert.equal(evaluate('bogus | core'), true, 'a known alternative still carries the term');
  assert.deepEqual(seen, ['bogus', 'bogus', 'bogus', 'bogus']);
});

test('token shapes: core, plugin:<id>, cap:<name>, and nothing else', () => {
  assert.equal(isKnownToken('core'), true);
  assert.equal(isKnownToken('plugin:appium'), true);
  assert.equal(isKnownToken('cap:mobile'), true);
  assert.equal(isKnownToken('plugin:'), false);
  assert.equal(isKnownToken('cap:'), false);
  assert.equal(isKnownToken('Core'), false);
  assert.equal(isKnownToken('appium'), false);
});

test('whitespace around tokens and separators is irrelevant', () => {
  assert.equal(holds('  plugin:appium  |  plugin:maestro  ', 'plugin:maestro'), true);
  assert.equal(holds('plugin:db ,, cap:git', 'plugin:db', 'cap:git'), true);
  assert.equal(holds('! plugin:perf'), true);
});
