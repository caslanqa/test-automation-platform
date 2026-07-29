/**
 * The `mongoDb` option and the `mongo` fixture — the same two-fixture shape as the SQL side, for the same
 * reason: the connection is worker-scoped and cannot skip, so a thin test-scoped fixture does.
 */
import type { Db, MongoClient } from 'mongodb';

import {
  closeMongoConnection,
  createMongoConnection,
  type MongoConnectionOptions,
} from './core/mongoConnection.js';
import { skipWithReason } from './skip.js';

export interface MongoOptions {
  /**
   * Where and which database. Omit either field and the matching MONGO_* env key fills it, so a project
   * configured through `env/environments.json` needs no `test.use({ mongoDb })` at all.
   */
  mongoDb?: Partial<MongoConnectionOptions>;
}

/** The worker's connection, or the reason there is none. Internal — tests use `mongo`. */
export interface MongoConnection {
  mongo?: Db;
  client?: MongoClient;
  reason?: string;
}

export interface MongoWorkerFixtures {
  mongoConnection: MongoConnection;
}

export interface MongoFixtures {
  /** A raw MongoDB `Db`: `await mongo.collection('users').find({ … }).toArray()`. */
  mongo: Db;
}

/**
 * Fill whatever the option left empty from the MONGO_* env keys — see the note in `fixtureSql.ts` for why the
 * reading happens in a fixture body rather than in the test file's module scope. The option wins over the env.
 */
function resolveMongoOptions(mongoDb?: Partial<MongoConnectionOptions>): MongoConnectionOptions {
  return {
    ...mongoDb,
    connection: mongoDb?.connection?.trim() || (process.env.MONGO_CONNECTION_STRING?.trim() ?? ''),
    database: mongoDb?.database?.trim() || (process.env.MONGO_DATABASE?.trim() ?? ''),
  };
}

export async function openMongoConnection(
  { mongoDb }: MongoOptions,
  use: (value: MongoConnection) => Promise<void>,
): Promise<void> {
  const opened = await createMongoConnection(resolveMongoOptions(mongoDb));
  if ('reason' in opened) {
    await use({ reason: opened.reason });
    return;
  }
  await use({ mongo: opened.mongo, client: opened.client });
  await closeMongoConnection(opened.client);
}

export async function provideMongo(
  { mongoConnection }: MongoWorkerFixtures,
  use: (value: Db) => Promise<void>,
  testInfo: { skip(condition: boolean, description: string): void },
): Promise<void> {
  if (!mongoConnection.mongo) {
    skipWithReason(testInfo, `[db] ${mongoConnection.reason ?? 'no MongoDB connection'}`);
    return;
  }
  await use(mongoConnection.mongo);
}
