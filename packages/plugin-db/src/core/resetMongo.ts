/**
 * Emptying collections between tests.
 *
 * `deleteMany({})` rather than `drop()`: dropping takes the indexes with it, so a suite that relies on a
 * unique index would pass for the wrong reason on every test after the first.
 *
 * @example await resetMongoDatabase(mongo, { collections: ['orders'] });
 */
import type { Db } from 'mongodb';

export interface ResetMongoOptions {
  /** Collections to empty. Omit to empty every collection except the migration bookkeeping. */
  collections?: string[];
}

/** Prefixed so it cannot collide with an application's own `_migrations`. */
export const MONGO_MIGRATIONS_COLLECTION = '_pwtap_migrations';

export async function resetMongoDatabase(
  mongo: Db,
  options: ResetMongoOptions = {},
): Promise<void> {
  const collections =
    options.collections ??
    (await mongo.listCollections({}, { nameOnly: true }).toArray())
      .map(entry => entry.name)
      .filter(name => name !== MONGO_MIGRATIONS_COLLECTION && !name.startsWith('system.'));

  await Promise.all(collections.map(name => mongo.collection(name).deleteMany({})));
}
