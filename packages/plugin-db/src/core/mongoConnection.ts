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
  // `create` writes both keys in empty for a user to fill, and `new MongoClient('')` throws a MongoParseError —
  // which used to happen OUTSIDE the try below, so an unconfigured MongoDB FAILED the test that this whole
  // return-a-reason contract exists to skip. Measured on a scaffolded project before it was checked here.
  if (options.connection.trim() === '') {
    return {
      reason:
        'no MongoDB connection configured \u2014 set `mongoDb.connection` (MONGO_CONNECTION_STRING in a scaffolded project)',
    };
  }
  if (options.database.trim() === '') {
    return {
      reason:
        'no MongoDB database configured \u2014 set `mongoDb.database` (MONGO_DATABASE in a scaffolded project)',
    };
  }
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let client: MongoClient;
  try {
    // Inside the try because the constructor parses the URI, and a malformed one must be a reason like any other.
    client = new MongoClient(options.connection, {
      serverSelectionTimeoutMS: timeout,
      connectTimeoutMS: timeout,
    });
  } catch (error) {
    return {
      reason: `MongoDB rejected the connection string \`${options.connection}\`: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
