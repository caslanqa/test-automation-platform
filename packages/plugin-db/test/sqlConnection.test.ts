/**
 * The reason `createSqlConnection` gives back when it cannot hand over a Knex instance.
 *
 * The drivers are optional peers, so "not installed" is the first thing a scaffolded project hits — and it is
 * the reason a reader sees printed next to a skipped test. Knex answers that case with `Cannot find module 'pg'`
 * plus a six-line require stack, which names no fix, so the message is ours instead.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSqlConnection } from '../src/core/sqlConnection.js';

test('an uninstalled driver is named with the install command, not a require stack', async () => {
  // `sqlite3` is the one client this repo deliberately does not install; `better-sqlite3` is the one it does.
  const result = await createSqlConnection({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
  });
  assert.ok('reason' in result, 'a missing driver cannot produce a connection');
  assert.equal(result.reason, 'the sqlite3 driver is not installed — run `npm i -D sqlite3`');
});

test('the driver name is what mysql and mariadb are told to install, not the client name', async () => {
  // mysql2 IS installed here, so this checks the mapping through the reachability path instead: the reason must
  // talk about the database, never claim a driver is missing.
  const result = await createSqlConnection({
    client: 'mariadb',
    connection: { host: '127.0.0.1', port: 1, user: 'nobody', database: 'nothing' },
  });
  assert.ok('reason' in result);
  assert.match(result.reason, /could not reach the mariadb database/);
});

/**
 * The unconfigured states, which are the ones a scaffolded project starts in.
 *
 * `create` writes DB_CLIENT and DB_CONNECTION_STRING into env/environments.json as empty strings for a user to
 * fill in, so `''` is normal input here, not a malformed one. Left to Knex it became `Required configuration
 * option 'client' is missing`, relayed inside `could not create a  connection` — a sentence with a hole in it.
 */
test("an empty client names the thing to set, not Knex's missing-option error", async () => {
  const result = await createSqlConnection({ client: '' as 'pg', connection: 'postgres://x/y' });
  assert.ok('reason' in result);
  assert.match(result.reason, /no SQL client configured/);
  assert.match(result.reason, /DB_CLIENT/, 'a scaffolded user looks for the env key');
  assert.doesNotMatch(result.reason, / {2}/, 'no hole where the client name should be');
});

test('a client spelled the way a user thinks of it is rejected by name', async () => {
  // The scaffolded connection string reads `postgresql://…`, so this is the spelling to expect.
  const result = await createSqlConnection({
    client: 'postgresql' as 'pg',
    connection: 'postgres://x/y',
  });
  assert.ok('reason' in result);
  assert.match(result.reason, /unknown SQL client `postgresql`/);
  assert.match(result.reason, /better-sqlite3/, 'and lists what to use instead');
});

test('an empty connection is reported against the client that needed one', async () => {
  const result = await createSqlConnection({ client: 'pg', connection: '' });
  assert.ok('reason' in result);
  assert.match(result.reason, /no pg connection configured/);
  assert.match(result.reason, /DB_CONNECTION_STRING/);
});

test('an empty connection object counts as unconfigured too', async () => {
  // SQLite takes `{ filename }` rather than a string, so emptiness has two shapes.
  const result = await createSqlConnection({ client: 'better-sqlite3', connection: {} });
  assert.ok('reason' in result);
  assert.match(result.reason, /no better-sqlite3 connection configured/);
});
