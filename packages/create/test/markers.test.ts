/**
 * Managed-region primitive tests. Four injectors (fixtures barrel, playwright.config, env json,
 * package.json) build on these functions, so a regression here silently corrupts a user's scaffolded
 * project in four places at once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addToRegion, hasRegion, MarkerError, removeFromRegion } from '../src/util/markers.js';

const doc = (inside = ''): string =>
  ['const before = 1;', '// pwtap:demo', inside, '// pwtap:demo:end', 'const after = 2;']
    .filter(line => line !== '')
    .join('\n');

test('hasRegion requires BOTH markers as whole lines', () => {
  assert.equal(hasRegion(doc(), 'demo'), true);
  assert.equal(hasRegion('nothing here', 'demo'), false);
});

test('a region missing only its START marker is reported as absent', () => {
  // The end marker `// pwtap:demo:end` CONTAINS the start marker `// pwtap:demo` as a substring, so a
  // substring-based check would wrongly report this file as intact and the caller would then hit a
  // MarkerError from addToRegion instead of the graceful "print a paste block" path.
  const orphaned = ['const before = 1;', '// pwtap:demo:end', 'const after = 2;'].join('\n');

  assert.equal(hasRegion(orphaned, 'demo'), false);
  assert.throws(() => addToRegion(orphaned, 'demo', '  x,', 'x,'), MarkerError);
});

test('a region missing only its END marker is reported as absent', () => {
  const orphaned = ['// pwtap:demo', 'const after = 2;'].join('\n');

  assert.equal(hasRegion(orphaned, 'demo'), false);
});

test('a marker only mentioned inside a string or comment is not a marker', () => {
  const mention = `const help = 'add // pwtap:demo to your file';`;

  assert.equal(hasRegion(mention, 'demo'), false, 'only a whole line counts as a marker');
});

test('addToRegion inserts before the end marker and is idempotent per uniq key', () => {
  const once = addToRegion(doc(), 'demo', '  maestroTest,', 'maestroTest,');
  assert.match(once, /\/\/ pwtap:demo\n {2}maestroTest,\n\/\/ pwtap:demo:end/);

  assert.equal(addToRegion(once, 'demo', '  maestroTest,', 'maestroTest,'), once);
});

test('addToRegion keeps existing entries when adding another', () => {
  let src = addToRegion(doc(), 'demo', '  a,', 'a,');
  src = addToRegion(src, 'demo', '  b,', 'b,');

  assert.match(src, /\/\/ pwtap:demo\n {2}a,\n {2}b,\n\/\/ pwtap:demo:end/);
});

test('removeFromRegion removes only matching lines, and only inside the region', () => {
  const src = addToRegion(addToRegion(doc(), 'demo', '  a,', 'a,'), 'demo', '  b,', 'b,');

  const stripped = removeFromRegion(src, 'demo', 'a,');

  assert.doesNotMatch(stripped, /^ {2}a,$/m);
  assert.match(stripped, /^ {2}b,$/m);
  assert.match(stripped, /const before = 1;/, 'content outside the region is untouched');
  assert.match(stripped, /const after = 2;/);
});

test('removeFromRegion is a no-op for an entry that is not there', () => {
  const src = addToRegion(doc(), 'demo', '  a,', 'a,');

  assert.equal(removeFromRegion(src, 'demo', 'nope,'), src);
});

test('MarkerError names the region so the CLI can tell the user which one to restore', () => {
  const error = new MarkerError('plugins:tests');

  assert.equal(error.key, 'plugins:tests');
  assert.match(error.message, /plugins:tests/);
});
