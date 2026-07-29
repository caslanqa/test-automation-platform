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

export interface MongoOptions {
  /** Where and which database. Omit and every test using `mongo` skips. */
  mongoDb?: MongoConnectionOptions;
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

export async function openMongoConnection(
  { mongoDb }: MongoOptions,
  use: (value: MongoConnection) => Promise<void>,
): Promise<void> {
  if (!mongoDb) {
    await use({
      reason: 'no MongoDB configured — set `mongoDb` in test.use({ … }) or the MONGO_* env keys',
    });
    return;
  }
  const opened = await createMongoConnection(mongoDb);
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
  testInfo.skip(
    !mongoConnection.mongo,
    `[db] ${mongoConnection.reason ?? 'no MongoDB connection'}`,
  );
  await use(mongoConnection.mongo as Db);
}
