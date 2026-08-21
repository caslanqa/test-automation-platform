/**
 * The ARIA snapshot parser, against snapshots **captured from real Playwright 1.61 failures**.
 *
 * This is the layer that reads someone else's output format, so the fixtures below are verbatim
 * rather than paraphrased — the same discipline as the error taxonomy, for the same reason.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  flatten,
  landmarkPath,
  parseAriaSnapshot,
  snapshotFromErrorContext,
} from '../src/heal/ariaSnapshot.js';

/** Verbatim from an error-context attachment on a rich page. */
const RICH = `- banner:
  - navigation "Main":
    - link "Home":
      - /url: /a
    - link "Cart":
      - /url: /b
- main:
  - form "Sign in":
    - text: Email
    - textbox "Email":
      - /placeholder: you@example.com
    - button "Log in"
  - region "Results":
    - list:
      - listitem:
        - button "Open"
        - text: Item A
      - listitem:
        - button "Open"
        - text: Item B
  - dialog "Welcome":
    - button "Dismiss"
`;

/** Verbatim from a minimal page — note the `- role: text` form. */
const SIMPLE = `- button "Log in"
- paragraph: Welcome, Ada
`;

test('roles, accessible names and nesting all parse', () => {
  const tree = parseAriaSnapshot(RICH);
  assert.deepEqual(
    tree.map(node => node.role),
    ['banner', 'main'],
  );
  const all = flatten(tree);
  const login = all.find(node => node.role === 'button' && node.name === 'Log in');
  assert.ok(login, 'the Log in button should be found');
  assert.deepEqual(
    login.path.map(ancestor => ancestor.role),
    ['main', 'form'],
  );
});

test('the `- role: text` form keeps the text separate from the name', () => {
  const [button, paragraph] = parseAriaSnapshot(SIMPLE);
  assert.equal(button.role, 'button');
  assert.equal(button.name, 'Log in');
  assert.equal(button.text, undefined);
  assert.equal(paragraph.role, 'paragraph');
  assert.equal(paragraph.name, undefined);
  assert.equal(paragraph.text, 'Welcome, Ada');
});

test('a property line attaches to the node above it, not to the tree', () => {
  const all = flatten(parseAriaSnapshot(RICH));
  const email = all.find(node => node.role === 'textbox');
  assert.equal(email?.props.placeholder, 'you@example.com');
  assert.equal(
    all.some(node => node.role === 'placeholder' || node.role === '/placeholder'),
    false,
    'a property must never become a node',
  );
  const home = all.find(node => node.name === 'Home');
  assert.equal(home?.props.url, '/a');
});

test('duplicates stay distinct, which is what makes uniqueness computable', () => {
  const opens = flatten(parseAriaSnapshot(RICH)).filter(
    node => node.role === 'button' && node.name === 'Open',
  );
  assert.equal(opens.length, 2);
  // Same name, different neighbourhood — the ordinal is recoverable and so is the container.
  assert.notEqual(opens[0], opens[1]);
  assert.deepEqual(landmarkPath(opens[0]), ['main', 'region "Results"', 'list', 'listitem']);
});

test('landmarkPath keeps only the roles that scope a region', () => {
  const all = flatten(parseAriaSnapshot(RICH));
  const dismiss = all.find(node => node.name === 'Dismiss');
  assert.deepEqual(landmarkPath(dismiss as never), ['main', 'dialog "Welcome"']);

  const login = all.find(node => node.name === 'Log in');
  assert.deepEqual(landmarkPath(login as never), ['main', 'form "Sign in"']);
});

test('a name containing a colon survives, because the name is taken before any split', () => {
  const [node] = parseAriaSnapshot('- button "Save: draft"\n');
  assert.equal(node.name, 'Save: draft');
  assert.equal(node.text, undefined);
});

test('indentation defines the tree, and dedenting closes the right number of levels', () => {
  const tree = parseAriaSnapshot(
    ['- main:', '  - list:', '    - listitem:', '      - button "A"', '  - button "B"'].join('\n'),
  );
  const [main] = tree;
  assert.equal(main.children.length, 2, 'list and button B are both children of main');
  assert.deepEqual(
    main.children.map(child => child.role),
    ['list', 'button'],
  );
});

test('malformed input yields whatever was readable rather than throwing', () => {
  assert.doesNotThrow(() => parseAriaSnapshot('not a snapshot at all'));
  assert.deepEqual(parseAriaSnapshot(''), []);
  assert.deepEqual(parseAriaSnapshot('   \n\n  \n'), []);
  // A continuation line has no `- ` and is skipped rather than mis-nesting everything after it.
  const tree = parseAriaSnapshot('- button "A"\n  wrapped continuation\n- button "B"\n');
  assert.deepEqual(
    tree.map(node => node.name),
    ['A', 'B'],
  );
});

test('the snapshot is extracted from the error-context markdown', () => {
  const markdown = [
    '# Test info',
    '',
    '```',
    'Error: expect(locator).toBeVisible() failed',
    '```',
    '',
    '```yaml',
    '- button "Log in"',
    '```',
    '',
    '# Test source',
  ].join('\n');
  assert.equal(snapshotFromErrorContext(markdown), '- button "Log in"\n');
  assert.equal(snapshotFromErrorContext('no fence here'), undefined);
});

test('with several yaml fences the last one is taken — the state closest to the failure', () => {
  const markdown = '```yaml\n- button "Old"\n```\n\n```yaml\n- button "New"\n```\n';
  assert.equal(snapshotFromErrorContext(markdown), '- button "New"\n');
});
