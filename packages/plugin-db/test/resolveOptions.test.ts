/**
 * Where the connection details come from when the test file does not spell them out.
 *
 * A user ran the scaffolded example and got `no pg connection configured` while the connection string sat filled
 * in inside `env/environments.json`. The example was reading `process.env` in its own module scope, and module
 * scope runs at a moment that depends on how the run was launched — so the read could happen before the config's
 * `loadEnv()` had reached that module, leaving both keys empty. The fixtures read the env themselves now, in a
 * body that cannot run before the config.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { openMongoConnection } from '../src/fixtureMongo.js';
import { openSqlConnection } from '../src/fixtureSql.js';

const KEYS = ['DB_CLIENT', 'DB_CONNECTION_STRING', 'MONGO_CONNECTION_STRING', 'MONGO_DATABASE'];
const saved = new Map(KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Run the worker fixture and report what it decided, without needing a database to exist. */
async function sqlReason(option?: Parameters<typeof openSqlConnection>[0]['db']): Promise<string> {
  let seen = '';
  await openSqlConnection({ db: option }, async connection => {
    seen = connection.reason ?? 'opened';
  });
  return seen;
}

test('with no option at all, the DB_* env keys are what configure the connection', async () => {
  process.env.DB_CLIENT = 'pg';
  process.env.DB_CONNECTION_STRING = 'postgres://nobody@127.0.0.1:1/nothing';
  // Reaching the reachability check is the proof: the client and connection both came from the env.
  assert.match(
    await sqlReason(undefined),
    /could not reach the pg database|the pg driver is not installed/,
  );
});

test('this is the exact run that was reported, and it no longer loses the connection', async () => {
  // What the old template produced when its module-scope read came up empty: client defaulted, connection did not.
  process.env.DB_CLIENT = 'pg';
  process.env.DB_CONNECTION_STRING = 'postgres://nobody@127.0.0.1:1/nothing';
  const reason = await sqlReason({ client: 'pg', connection: '' });
  assert.doesNotMatch(
    reason,
    /no pg connection configured/,
    'the env must fill what the option left empty',
  );
});

test('an option that names a connection wins over the env', async () => {
  process.env.DB_CLIENT = 'pg';
  process.env.DB_CONNECTION_STRING = 'postgres://nobody@127.0.0.1:1/nothing';
  const reason = await sqlReason({ client: 'mariadb', connection: { host: '127.0.0.1', port: 1 } });
  assert.match(reason, /mariadb/, 'the explicit client is the one used');
});

test('nothing configured anywhere still names the key to set', async () => {
  delete process.env.DB_CLIENT;
  delete process.env.DB_CONNECTION_STRING;
  assert.match(await sqlReason(undefined), /no SQL client configured.*DB_CLIENT/s);
});

test('MongoDB is filled from its own env keys the same way', async () => {
  process.env.MONGO_CONNECTION_STRING = 'mongodb://127.0.0.1:1';
  process.env.MONGO_DATABASE = 'app_test';
  let seen = '';
  await openMongoConnection({}, async connection => {
    seen = connection.reason ?? 'opened';
  });
  assert.match(seen, /could not reach MongoDB at mongodb:\/\/127\.0\.0\.1:1/);
});
