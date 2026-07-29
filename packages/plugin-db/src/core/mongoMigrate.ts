/**
 * A migration runner for MongoDB, because there is no official one and a third dependency is not worth it.
 *
 * Deliberately the same authoring experience as the SQL side — a directory of files, each exporting `up(db)`
 * and `down(db)`, applied in filename order — while the engine underneath is entirely different: Knex has its
 * own runner and this is ours. Applied migrations are recorded in `_pwtap_migrations`, prefixed so it cannot
 * collide with an application's own bookkeeping.
 *
 * @example await runMongoMigrations(mongo, 'db/migrations-mongo');
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Db } from 'mongodb';

import { MONGO_MIGRATIONS_COLLECTION } from './resetMongo.js';

/** What a migration file must export. */
export interface MongoMigration {
  up(db: Db): Promise<void>;
  down(db: Db): Promise<void>;
}

/** One row of the bookkeeping collection. */
interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

/** Compiled or source, either is loadable; anything else in the directory is not a migration. */
const MIGRATION_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'];

/**
 * Apply every migration not yet recorded, in filename order, and record each as it succeeds.
 *
 * Recording after each one rather than at the end is what makes a failed run resumable: the migrations that
 * did apply stay applied, and the next run starts from the one that failed.
 */
export async function runMongoMigrations(db: Db, dir: string): Promise<string[]> {
  const files = await migrationFiles(dir);
  const applied = new Set(await appliedNames(db));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const migration = await load(dir, file);
    await migration.up(db);
    await db
      .collection<AppliedMigration>(MONGO_MIGRATIONS_COLLECTION)
      .insertOne({ name: file, appliedAt: new Date() });
    ran.push(file);
  }
  return ran;
}

/**
 * Undo the most recently applied migration — one step, not the whole history, matching `knex migrate:rollback`
 * closely enough that the two engines feel the same. Returns the name undone, or `undefined` when there is
 * nothing to undo.
 */
export async function rollbackMongoMigration(db: Db, dir: string): Promise<string | undefined> {
  const collection = db.collection<AppliedMigration>(MONGO_MIGRATIONS_COLLECTION);
  // By name, not by `appliedAt`: two migrations applied inside the same millisecond would otherwise roll back
  // in an arbitrary order, and names are what define the order everywhere else here.
  const last = await collection.find({}).sort({ name: -1 }).limit(1).next();
  if (!last) {
    return undefined;
  }
  const migration = await load(dir, last.name);
  await migration.down(db);
  await collection.deleteOne({ name: last.name });
  return last.name;
}

/** Migration names already recorded as applied. */
export async function appliedNames(db: Db): Promise<string[]> {
  const rows = await db
    .collection<AppliedMigration>(MONGO_MIGRATIONS_COLLECTION)
    .find({}, { projection: { name: 1 } })
    .sort({ name: 1 })
    .toArray();
  return rows.map(row => row.name);
}

/** Migration filenames in the directory, sorted, which is the order they apply in. */
async function migrationFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile() && MIGRATION_EXTENSIONS.includes(path.extname(entry.name)))
    .filter(entry => !entry.name.endsWith('.d.ts'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function load(dir: string, file: string): Promise<MongoMigration> {
  const resolved = path.resolve(dir, file);
  const mod = (await import(pathToFileURL(resolved).href)) as {
    default?: Partial<MongoMigration>;
  } & Partial<MongoMigration>;
  // Either shape works — a default export or named ones — because both read naturally and a migration author
  // should not have to remember which.
  const candidate = typeof mod.up === 'function' ? mod : mod.default;
  if (!candidate || typeof candidate.up !== 'function' || typeof candidate.down !== 'function') {
    throw new Error(
      `[db] ${file} is not a migration: it must export \`up(db)\` and \`down(db)\`, either named or on a default export`,
    );
  }
  return candidate as MongoMigration;
}
