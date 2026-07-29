/**
 * The Mongo migration runner — the one piece of this plugin with no precedent in the repo, so the one that
 * needs its own tests rather than borrowing confidence from Knex.
 *
 * Runs against a real MongoDB because the thing being tested is the bookkeeping, and a fake collection would
 * only test the fake. Skips when none is reachable, the same way the device tests do:
 *
 *   docker run -d -p 57017:27017 mongo:7
 *   PWTAP_MONGO_URI=mongodb://127.0.0.1:57017 npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { Db, MongoClient } from 'mongodb';

import { closeMongoConnection, createMongoConnection } from '../src/core/mongoConnection.js';
import {
  appliedNames,
  rollbackMongoMigration,
  runMongoMigrations,
} from '../src/core/mongoMigrate.js';
import { MONGO_MIGRATIONS_COLLECTION } from '../src/core/resetMongo.js';

const URI = process.env.PWTAP_MONGO_URI ?? 'mongodb://127.0.0.1:57017';
let client: MongoClient | undefined;
let mongo: Db | undefined;
let dir = '';

/** Two migrations: the second depends on the first having run, so order is observable. */
async function writeMigrations(): Promise<void> {
  await fs.writeFile(
    path.join(dir, '0001_people.mjs'),
    `export async function up(db) { await db.createCollection('people'); await db.collection('people').insertOne({ name: 'ada' }); }
     export async function down(db) { await db.collection('people').drop(); }\n`,
  );
  await fs.writeFile(
    path.join(dir, '0002_add_city.mjs'),
    `export async function up(db) { await db.collection('people').updateMany({}, { $set: { city: 'london' } }); }
     export async function down(db) { await db.collection('people').updateMany({}, { $unset: { city: '' } }); }\n`,
  );
  // Not a migration, and must be ignored rather than crashing the run.
  await fs.writeFile(path.join(dir, 'README.md'), 'notes\n');
}

before(async () => {
  const opened = await createMongoConnection({
    connection: URI,
    database: `pwtap_migrate_${process.pid}`,
    timeoutMs: 2_000,
  });
  if ('reason' in opened) {
    return; // every test below skips
  }
  client = opened.client;
  mongo = opened.mongo;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-mongo-mig-'));
  await writeMigrations();
});

after(async () => {
  if (mongo) {
    await mongo.dropDatabase().catch(() => undefined);
  }
  if (client) {
    await closeMongoConnection(client);
  }
  if (dir) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Skip with a reason rather than fail when there is no MongoDB to run against. */
function db(t: { skip: (reason: string) => void }): Db | undefined {
  if (!mongo) {
    t.skip(`no MongoDB at ${URI} — start one and set PWTAP_MONGO_URI to run this`);
    return undefined;
  }
  return mongo;
}

test('migrations apply in filename order, and non-migrations are ignored', async t => {
  const target = db(t);
  if (!target) return;

  const ran = await runMongoMigrations(target, dir);

  assert.deepEqual(
    ran,
    ['0001_people.mjs', '0002_add_city.mjs'],
    'sorted, and README.md left alone',
  );
  const person = await target.collection('people').findOne({ name: 'ada' });
  assert.equal(person?.city, 'london', 'the second migration saw what the first created');
});

test('a second run applies nothing — the bookkeeping is what makes it idempotent', async t => {
  const target = db(t);
  if (!target) return;

  const ran = await runMongoMigrations(target, dir);

  assert.deepEqual(ran, []);
  assert.deepEqual(await appliedNames(target), ['0001_people.mjs', '0002_add_city.mjs']);
});

test('rollback undoes exactly the last migration, not the whole history', async t => {
  const target = db(t);
  if (!target) return;

  const undone = await rollbackMongoMigration(target, dir);

  assert.equal(undone, '0002_add_city.mjs');
  assert.deepEqual(await appliedNames(target), ['0001_people.mjs'], 'the first stays applied');
  const person = await target.collection('people').findOne({ name: 'ada' });
  assert.equal(person?.city, undefined, 'and its effect is gone');
  assert.ok(person, 'while the first migration’s row survives');
});

test('rolling back to empty reports nothing left to undo', async t => {
  const target = db(t);
  if (!target) return;

  assert.equal(await rollbackMongoMigration(target, dir), '0001_people.mjs');
  assert.equal(
    await rollbackMongoMigration(target, dir),
    undefined,
    'an empty history is not an error',
  );
  assert.deepEqual(await appliedNames(target), []);
});

test('a file that is not a migration fails by name, not with a cryptic TypeError', async t => {
  const target = db(t);
  if (!target) return;
  const broken = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-mongo-bad-'));
  await fs.writeFile(path.join(broken, '0001_oops.mjs'), 'export const nope = 1;\n');

  await assert.rejects(
    () => runMongoMigrations(target, broken),
    /0001_oops\.mjs is not a migration/,
  );
  await fs.rm(broken, { recursive: true, force: true });
});

test('the bookkeeping collection is prefixed so it cannot collide with an app collection', async t => {
  const target = db(t);
  if (!target) return;

  assert.equal(MONGO_MIGRATIONS_COLLECTION, '_pwtap_migrations');
  await runMongoMigrations(target, dir);
  const names = (await target.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  assert.ok(names.includes('_pwtap_migrations'));
});
