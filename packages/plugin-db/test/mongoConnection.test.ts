/**
 * The reason `createMongoConnection` gives back, especially when nothing is configured.
 *
 * This is the case that FAILED a test instead of skipping it: `new MongoClient('')` throws a MongoParseError, and
 * it was constructed outside the try, so the whole return-a-reason contract was bypassed. Measured on a
 * scaffolded project — `1 failed` — before it was checked. MONGO_CONNECTION_STRING and MONGO_DATABASE both ship
 * empty, so this is the state every fresh project is in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMongoConnection } from '../src/core/mongoConnection.js';

test('an unconfigured MongoDB is a reason, never a thrown parse error', async () => {
  const result = await createMongoConnection({ connection: '', database: '' });
  assert.ok('reason' in result, 'this must not throw — an unconfigured database skips');
  assert.match(result.reason, /no MongoDB connection configured/);
  assert.match(result.reason, /MONGO_CONNECTION_STRING/);
});

test('a connection with no database named is its own reason', async () => {
  // Deliberate: asserting against whichever database the URI happened to name is a trap, so the name is required.
  const result = await createMongoConnection({
    connection: 'mongodb://127.0.0.1:27017',
    database: '   ',
  });
  assert.ok('reason' in result);
  assert.match(result.reason, /no MongoDB database configured/);
});

test('a malformed connection string is a reason as well, not a throw', async () => {
  const result = await createMongoConnection({ connection: 'postgres://wrong', database: 'app' });
  assert.ok('reason' in result);
  assert.match(result.reason, /rejected the connection string/);
});
