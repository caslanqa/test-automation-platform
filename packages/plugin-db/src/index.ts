/**
 * `@pwtap/plugin-db` — database testing with two independent fixture families.
 *
 * One `base.extend` rather than `mergeTests`: unlike the two mobile plugins, which are separate packages, both
 * families ship here, so they are declared together in a single call. `db`→`sql` and `mongoDb`→`mongo` are four
 * distinct names, so this test object merges into a project's `@fixtures` barrel alongside every other plugin.
 *
 * @example
 * import { test, expect } from '@fixtures';
 * test.use({ db: { client: 'pg', connection: process.env.DB_CONNECTION_STRING! } });
 * test('the order was written', async ({ request, sql }) => {
 *   await request.post('/orders', { data: { sku: 'x' } });
 *   expect(await sql('orders').where({ sku: 'x' }).first()).toBeTruthy();
 * });
 */
import { test as base, expect } from '@playwright/test';

import {
  openMongoConnection,
  provideMongo,
  type MongoFixtures,
  type MongoOptions,
  type MongoWorkerFixtures,
} from './fixtureMongo.js';
import {
  openSqlConnection,
  provideSql,
  type SqlFixtures,
  type SqlOptions,
  type SqlWorkerFixtures,
} from './fixtureSql.js';

export type DbOptions = SqlOptions & MongoOptions;
export type DbFixtures = SqlFixtures & MongoFixtures;
/**
 * The options live here, with the connections, not with the test fixtures. A worker-scoped fixture may only
 * depend on worker-scoped things, so `db`/`mongoDb` have to be worker-scoped for `sqlConnection` to read them —
 * and Playwright takes a fixture's scope from WHICH type parameter declares it, so putting them anywhere else
 * is rejected outright.
 */
export type DbWorkerFixtures = DbOptions & SqlWorkerFixtures & MongoWorkerFixtures;

export const test = base.extend<DbFixtures, DbWorkerFixtures>({
  db: [undefined, { option: true, scope: 'worker' }],
  sqlConnection: [openSqlConnection, { scope: 'worker' }],
  sql: provideSql,

  mongoDb: [undefined, { option: true, scope: 'worker' }],
  mongoConnection: [openMongoConnection, { scope: 'worker' }],
  mongo: provideMongo,
});

export {
  closeMongoConnection,
  createMongoConnection,
  type MongoConnectionOptions,
} from './core/mongoConnection.js';
export {
  appliedNames,
  rollbackMongoMigration,
  runMongoMigrations,
  type MongoMigration,
} from './core/mongoMigrate.js';
export {
  MONGO_MIGRATIONS_COLLECTION,
  resetMongoDatabase,
  type ResetMongoOptions,
} from './core/resetMongo.js';
export { resetSqlDatabase, type ResetSqlOptions } from './core/resetSql.js';
export {
  closeSqlConnection,
  createSqlConnection,
  type SqlClient,
  type SqlConnectionOptions,
} from './core/sqlConnection.js';
export { expect };
