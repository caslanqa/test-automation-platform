/**
 * The safety boundary: is the replacement the same element?
 *
 * The assertions that matter most are the refusals. A locator that resolves and makes the assertion
 * pass has proved nothing — it may be pointing at a different element that happens to satisfy the
 * check, which is how a caught bug becomes a green test. So `proven` has to be hard to reach, and
 * every weaker verdict has to be reported as weaker rather than rounded up.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAriaSnapshot } from '../src/heal/ariaSnapshot.js';
import { webLocatorCandidates, type HealCandidate } from '../src/heal/candidates.js';
import { eligibleForAutofix, proveEquivalence } from '../src/heal/equivalence.js';
import { parseLocatorIntent } from '../src/heal/intent.js';

const PAGE = parseAriaSnapshot(`- main:
  - form "Sign in":
    - textbox "Email"
    - button "Continue"
  - dialog "Checkout":
    - button "Continue"
  - button "Log in"
  - paragraph: Welcome, Ada
`);

const prove = (locator: string, page = PAGE) => {
  const intent = parseLocatorIntent(locator);
  const [best] = webLocatorCandidates(page, intent);
  assert.ok(best !== undefined, `no candidate for ${locator}`);
  return { equivalence: proveEquivalence(intent, best, page), candidate: best, intent };
};

/** One Continue, so the choice is forced and the proof is about what it claims to be about. */
const UNAMBIGUOUS = parseAriaSnapshot(`- main:
  - form "Sign in":
    - textbox "Email"
    - button "Continue"
  - button "Log in"
`);

test('role and name both matching, with a unique candidate, is proven', () => {
  // The wrapper class is what drifted; the code still states a role and a name, and both hold.
  const { equivalence, candidate } = prove(
    "locator('form.signin').getByRole('button', { name: 'Continue' })",
    UNAMBIGUOUS,
  );
  assert.equal(equivalence.verdict, 'proven');
  assert.deepEqual(equivalence.matched.sort(), ['name', 'role']);
  assert.equal(equivalence.uniqueMatches, 1);
  assert.equal(eligibleForAutofix(equivalence), true);
  assert.ok(candidate.code.includes("name: 'Continue'"));
});

test('a structural scope still constrains the KIND of container', () => {
  // Continue appears in both a form and a dialog, and the ranking leads with the dialog's. Before
  // this guard existed, role+name "proved" the dialog button for a locator scoped to a form.
  const { equivalence } = prove("locator('form.signin').getByRole('button', { name: 'Continue' })");
  assert.notEqual(equivalence.verdict, 'proven', 'the wrong container must never be proven');
  assert.equal(equivalence.verdict, 'moved');
  assert.equal(equivalence.outsideScope, 'form');
  assert.equal(eligibleForAutofix(equivalence), false);
});

test('an identifier-only locator can never be proven — nothing was stated to check', () => {
  for (const locator of ["getByTestId('submit')", "locator('#login-button')"]) {
    const { equivalence } = prove(locator);
    assert.equal(equivalence.verdict, 'refused', locator);
    assert.ok(
      equivalence.reasons.some(reason => reason.startsWith('no-shared-signal')),
      `${locator}: ${JSON.stringify(equivalence.reasons)}`,
    );
    assert.equal(eligibleForAutofix(equivalence), false);
  }
});

test('one matching signal with a page-unique name is likely, not proven', () => {
  // getByLabel states a name only. "Email" appears once on the page, so it is a strong identifier —
  // strong enough to offer, not strong enough to apply.
  const { equivalence } = prove("getByLabel('Email')");
  assert.equal(equivalence.verdict, 'likely');
  assert.deepEqual(equivalence.matched, ['name']);
  assert.equal(eligibleForAutofix(equivalence), false, 'advisory, never applied');
});

test('one matching signal with a repeated name is refused', () => {
  // "Continue" appears twice, so matching the name alone says nothing about which one.
  const { equivalence } = prove("getByLabel('Continue')");
  assert.equal(equivalence.verdict, 'refused');
  assert.ok(equivalence.reasons.some(reason => reason.startsWith('one-signal')));
});

test('a candidate outside the scope the locator stated is moved, not proven', () => {
  const page = parseAriaSnapshot(`- main:
  - form "Sign in":
    - textbox "Email"
  - dialog "Welcome":
    - button "Continue"
`);
  const { equivalence } = prove(
    "getByRole('form', { name: 'Sign in' }).getByRole('button', { name: 'Continue' })",
    page,
  );
  assert.equal(equivalence.verdict, 'moved');
  assert.equal(equivalence.outsideScope, 'form "Sign in"');
  assert.equal(eligibleForAutofix(equivalence), false, 'a redesign needs a human');
  assert.ok(equivalence.reasons.some(reason => reason.includes('intended redesign')));
});

test('a scope that IS the failing locator is not treated as a constraint', () => {
  // `getByRole('button', { name: 'Log in' })` with nothing chained after it is the locator itself,
  // not a scope — reading it as one would make every unscoped repair look moved.
  const { equivalence } = prove("getByRole('button', { name: 'Log in' })");
  assert.equal(equivalence.verdict, 'proven');
  assert.equal(equivalence.outsideScope, undefined);
});

test('a non-unique candidate is refused however many signals match', () => {
  const intent = parseLocatorIntent("getByRole('button', { name: 'Continue' })");
  const candidates = webLocatorCandidates(PAGE, intent);
  const ambiguous = candidates.find(candidate => !candidate.unique);
  assert.ok(ambiguous, 'the two Continue buttons make the plain candidate non-unique');
  const equivalence = proveEquivalence(intent, ambiguous, PAGE);
  assert.equal(equivalence.verdict, 'refused');
  assert.ok(equivalence.reasons.some(reason => reason.startsWith('not-unique')));
});

test('a candidate below the score floor is refused before anything else is considered', () => {
  const intent = parseLocatorIntent("getByRole('button', { name: 'Log in' })");
  const [best] = webLocatorCandidates(PAGE, intent);
  const fragile: HealCandidate = { ...best, score: 20, confidence: 'low' };
  const equivalence = proveEquivalence(intent, fragile, PAGE);
  assert.equal(equivalence.verdict, 'refused');
  assert.ok(equivalence.reasons.some(reason => reason.startsWith('too-fragile')));
});

test('the landmark path is always reported, proven or not', () => {
  const proven = prove(
    "locator('form.signin').getByRole('button', { name: 'Continue' })",
    UNAMBIGUOUS,
  );
  assert.deepEqual(proven.equivalence.landmarkPath, ['main', 'form "Sign in"']);

  const refused = prove("getByTestId('submit')");
  assert.ok(Array.isArray(refused.equivalence.landmarkPath), 'a reviewer wants it either way');
});

test('names differing only in case or trailing punctuation still match', () => {
  const page = parseAriaSnapshot('- main:\n  - button "Log In :"\n');
  const { equivalence } = prove("getByRole('button', { name: 'log in' })", page);
  assert.equal(equivalence.verdict, 'proven');
  assert.deepEqual(equivalence.matched.sort(), ['name', 'role']);
});

test('a role that changed leaves one signal, so it cannot be proven', () => {
  // The element is now a link, not a button. The name still matches; the role does not.
  const page = parseAriaSnapshot('- main:\n  - link "Log in"\n');
  const { equivalence } = prove("getByRole('button', { name: 'Log in' })", page);
  assert.equal(equivalence.verdict, 'likely', 'the name is page-unique, which is strong');
  assert.deepEqual(equivalence.matched, ['name']);
  assert.equal(eligibleForAutofix(equivalence), false);
});
