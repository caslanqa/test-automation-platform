/**
 * Opening a MongoDB connection, and proving it works before a test relies on it.
 *
 * Same contract as the SQL side: a reason instead of a throw, because unreachable means skip. The driver
 * connects lazily, so the `ping` is what actually establishes that the server is there.
 *
 * @example const opened = await createMongoConnection({ connection: 'mongodb://127.0.0.1:27017', database: 'app_test' });
 */
import { MongoClient, type Db } from 'mongodb';

export interface MongoConnectionOptions {
  /** A MongoDB connection string. */
  connection: string;
  /** Database to use. Required: a test asserting against "whichever database the URI happened to name" is a trap. */
  database: string;
  /** How long to wait for a server before giving up and skipping, rather than hanging the run. */
  timeoutMs?: number;
}

export type MongoConnectionResult = { client: MongoClient; mongo: Db } | { reason: string };

const DEFAULT_TIMEOUT_MS = 5_000;

export async function createMongoConnection(
  options: MongoConnectionOptions,
): Promise<MongoConnectionResult> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new MongoClient(options.connection, {
    serverSelectionTimeoutMS: timeout,
    connectTimeoutMS: timeout,
  });
  try {
    await client.connect();
    const mongo = client.db(options.database);
    await mongo.command({ ping: 1 });
    return { client, mongo };
  } catch (error) {
    await client.close().catch(() => undefined);
    return {
      reason: `could not reach MongoDB at ${options.connection}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function closeMongoConnection(client: MongoClient): Promise<void> {
  await client.close().catch(() => undefined);
}
