/**
 * Locator intent and candidate ranking.
 *
 * The assertion shapes deliberately mirror `packages/mobile-core/test/locator.test.ts`, because the
 * two engines share a scoring *policy* and drifting apart silently would make them incomparable: the
 * same −25 for a non-unique match, the same −10 for a disambiguating ordinal, and the same rule that
 * every risky candidate states what makes it risky.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { flatten, parseAriaSnapshot } from '../src/heal/ariaSnapshot.js';
import { normalizeName, targetsFor, webLocatorCandidates } from '../src/heal/candidates.js';
import { parseLocatorIntent } from '../src/heal/intent.js';

const PAGE = parseAriaSnapshot(`- banner:
  - navigation "Main":
    - link "Home"
- main:
  - form "Sign in":
    - textbox "Email":
      - /placeholder: you@example.com
    - button "Continue"
  - region "Results":
    - list:
      - listitem:
        - button "Open"
      - listitem:
        - button "Open"
  - dialog "Checkout":
    - button "Continue"
  - paragraph: Welcome, Ada
`);

const codesFor = (locator: string): string[] =>
  webLocatorCandidates(PAGE, parseLocatorIntent(locator)).map(candidate => candidate.code);

// --- intent ----------------------------------------------------------------------------------

test('getByRole states two signals: a role and a name', () => {
  const intent = parseLocatorIntent("getByRole('button', { name: 'Log in' })");
  assert.equal(intent.role, 'button');
  assert.equal(intent.name, 'Log in');
  assert.deepEqual(intent.signals, ['role', 'name']);
  assert.equal(intent.structural, false);
});

test('an identifier-only locator states one signal, and it is the one that vanished', () => {
  const byTestId = parseLocatorIntent("getByTestId('submit')");
  assert.equal(byTestId.testId, 'submit');
  assert.deepEqual(byTestId.signals, ['testId']);
  assert.equal(byTestId.name, undefined, 'nothing in the code says what the element was called');

  const byId = parseLocatorIntent("locator('#login-button')");
  assert.equal(byId.cssId, 'login-button');
  assert.deepEqual(byId.signals, []);
  assert.equal(byId.structural, true);
});

test('a label, a placeholder and text each state a name, and say which kind', () => {
  assert.deepEqual(
    ['getByLabel', 'getByPlaceholder', 'getByText', 'getByTitle', 'getByAltText'].map(method => {
      const intent = parseLocatorIntent(`${method}('Email')`);
      return [intent.name, intent.nameKind];
    }),
    [
      ['Email', 'label'],
      ['Email', 'placeholder'],
      ['Email', 'text'],
      ['Email', 'title'],
      ['Email', 'altText'],
    ],
  );
});

test('a chained locator contributes what each link states, and an ordinal is read', () => {
  const intent = parseLocatorIntent(
    "locator('form.signin').getByRole('button', { name: 'Continue' }).nth(2)",
  );
  assert.equal(intent.role, 'button');
  assert.equal(intent.name, 'Continue');
  assert.equal(intent.ordinal, 2);
  assert.deepEqual(intent.signals, ['role', 'name']);
  assert.equal(intent.structural, false, 'it stated semantics as well as structure');
  assert.equal(parseLocatorIntent("getByRole('button').first()").ordinal, 0);
});

test('names are normalised for comparison, not for display', () => {
  assert.equal(normalizeName('  Log   In :'), 'log in');
  assert.equal(normalizeName('Continue…'), 'continue');
  assert.equal(normalizeName('Email*'), 'email');
});

// --- targets ---------------------------------------------------------------------------------

test('a name in the code selects the nodes carrying that name', () => {
  const targets = targetsFor(PAGE, parseLocatorIntent("getByRole('button', { name: 'Continue' })"));
  assert.equal(targets.length, 2, 'the form button and the dialog button both carry it');
  assert.ok(targets.every(node => node.role === 'button'));
});

test('with nothing searchable, the addressable elements are offered — suggesting, not proving', () => {
  const targets = targetsFor(PAGE, parseLocatorIntent("getByTestId('gone')"));
  assert.ok(targets.length > 3, 'a reviewer gets the list they would have written out by hand');
  assert.ok(
    targets.every(node => node.name !== undefined && node.name !== ''),
    'only elements a locator can name at all',
  );
});

// --- ranking ---------------------------------------------------------------------------------

test('role and accessible name lead the ranking', () => {
  const [first] = codesFor("getByRole('link', { name: 'Home' })");
  assert.equal(first, "getByRole('link', { name: 'Home' })");
  const [candidate] = webLocatorCandidates(
    PAGE,
    parseLocatorIntent("getByRole('link', { name: 'Home' })"),
  );
  assert.equal(candidate.score, 85);
  assert.equal(candidate.confidence, 'high');
  assert.equal(candidate.unique, true);
  assert.deepEqual(candidate.warnings, []);
});

test('a non-unique candidate loses exactly 25 and says why', () => {
  const candidates = webLocatorCandidates(
    PAGE,
    parseLocatorIntent("getByRole('button', { name: 'Open' })"),
  );
  const plain = candidates.find(candidate => candidate.strategy === 'role');
  assert.ok(plain);
  assert.equal(plain.score, 85 - 25, 'the same penalty the mobile engine applies');
  assert.equal(plain.unique, false);
  assert.ok(plain.warnings.some(warning => warning.startsWith('not unique')));
});

test('a deterministic ordinal outranks a locator that matches several elements', () => {
  const candidates = webLocatorCandidates(
    PAGE,
    parseLocatorIntent("getByRole('button', { name: 'Open' })"),
  );
  const plain = candidates.find(candidate => candidate.strategy === 'role');
  const ordinal = candidates.find(candidate => candidate.strategy === 'roleOrdinal');
  assert.ok(plain && ordinal);
  // −10 against −25, the same arithmetic mobile-core uses: a non-unique locator resolves to
  // whichever element the driver returns first, and that is not a contract.
  assert.ok(ordinal.score > plain.score, 'the disambiguated one is the safer of two bad options');
  assert.match(ordinal.code, /\.nth\(\d\)$/);
  assert.equal(ordinal.unique, true, 'it selects among the matches by construction');
  assert.ok(ordinal.warnings.some(warning => warning.startsWith('position-dependent')));
  assert.ok(
    plain.warnings.some(warning => warning.startsWith('not unique')),
    'and the plain one is still offered, saying why it is risky',
  );
});

test('a repeated name inside a named landmark is rescued by scoping, above the ordinal', () => {
  const candidates = webLocatorCandidates(
    PAGE,
    parseLocatorIntent("getByRole('button', { name: 'Continue' })"),
  );
  const scoped = candidates.find(candidate => candidate.strategy === 'roleInLandmark');
  assert.ok(scoped, 'both Continue buttons sit in differently-named containers');
  assert.match(
    scoped.code,
    /^getByRole\('(form|dialog)', \{ name: '(Sign in|Checkout)' \}\)\.getByRole/,
  );
  assert.equal(scoped.unique, true);

  const ordinal = candidates.find(candidate => candidate.strategy === 'roleOrdinal');
  assert.ok(ordinal === undefined || scoped.score > ordinal.score, 'scoping beats an ordinal');
});

test('a placeholder is offered, and says it disappears once the field is filled', () => {
  const candidates = webLocatorCandidates(
    PAGE,
    parseLocatorIntent("getByRole('textbox', { name: 'Email' })"),
  );
  const placeholder = candidates.find(candidate => candidate.strategy === 'placeholder');
  assert.ok(placeholder);
  assert.equal(placeholder.code, "getByPlaceholder('you@example.com')");
  assert.equal(placeholder.score, 70);
  assert.ok(placeholder.warnings.some(warning => warning.includes('once the field is filled')));
});

test('text is offered last of the real strategies, and long text is flagged', () => {
  const short = webLocatorCandidates(PAGE, parseLocatorIntent("getByText('Welcome, Ada')"));
  const text = short.find(candidate => candidate.strategy === 'text');
  assert.ok(text);
  assert.equal(text.score, 58);
  assert.deepEqual(text.warnings, []);

  const sentence = 'a rather long sentence that a translator will certainly rewrite';
  const wordy = parseAriaSnapshot(`- paragraph: ${sentence}\n`);
  const long = webLocatorCandidates(wordy, parseLocatorIntent(`getByText('${sentence}')`));
  assert.ok(
    long.some(candidate => candidate.warnings.some(warning => warning.includes('long text'))),
    'copy long enough to be translated is copy that will change',
  );
});

test('no test-id candidate is ever offered — the snapshot cannot see one', () => {
  const everything = flatten(PAGE).flatMap(node =>
    webLocatorCandidates(PAGE, parseLocatorIntent("getByTestId('x')"), { target: node }),
  );
  assert.equal(
    everything.some(candidate => candidate.code.includes('getByTestId')),
    false,
  );
});

test('the ranking is stable across calls, so a rendered proposal is reproducible', () => {
  assert.deepEqual(
    codesFor("getByRole('button', { name: 'Continue' })"),
    codesFor("getByRole('button', { name: 'Continue' })"),
  );
});

test('nothing to point at yields nothing, rather than an invented locator', () => {
  const empty = webLocatorCandidates([], parseLocatorIntent("getByRole('button', { name: 'x' })"));
  assert.deepEqual(empty, []);
});
