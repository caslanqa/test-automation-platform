/**
 * The `db` option and the `sql` fixture.
 *
 * Two fixtures, not one, and for a reason worth stating: the connection is worker-scoped so a whole worker
 * shares one pool, but a worker fixture is handed `workerInfo` and has no way to skip a test. So the
 * worker-scoped one opens the connection or reports why it could not, and the test-scoped `sql` either hands
 * the instance over or skips — which is what an unreachable database must do (never fail).
 *
 * Both the option and the connection are worker-scoped, because Playwright forbids a worker fixture from
 * depending on a test-scoped one. Setting a different `db` in another file therefore runs it in another worker
 * with its own connection: the cost of pooling per worker, and why `test.use({ db })` belongs at the top level
 * of a file rather than inside a `describe`.
 *
 * The bodies are exported as plain functions so `index.ts` can assemble one `base.extend` with no casts.
 */
import type { Knex } from 'knex';

import {
  closeSqlConnection,
  createSqlConnection,
  type SqlConnectionOptions,
} from './core/sqlConnection.js';
import { skipWithReason } from './skip.js';

export interface SqlOptions {
  /** Which engine and where. Omit and every test using `sql` skips. */
  db?: SqlConnectionOptions;
}

/** The worker's connection, or the reason there is none. Internal — tests use `sql`. */
export interface SqlConnection {
  sql?: Knex;
  reason?: string;
}

export interface SqlWorkerFixtures {
  sqlConnection: SqlConnection;
}

export interface SqlFixtures {
  /** A raw Knex instance: `await sql('users').where({ id }).first()`. */
  sql: Knex;
}

/** Worker-scoped: one connection for every test this worker runs. */
export async function openSqlConnection(
  { db }: SqlOptions,
  use: (value: SqlConnection) => Promise<void>,
): Promise<void> {
  if (!db) {
    await use({
      reason: 'no database configured — set `db` in test.use({ … }) or the DB_* env keys',
    });
    return;
  }
  const opened = await createSqlConnection(db);
  if ('reason' in opened) {
    await use({ reason: opened.reason });
    return;
  }
  await use({ sql: opened.sql });
  // Playwright tears a worker fixture down when the worker ends, so no teardown project is needed.
  await closeSqlConnection(opened.sql);
}

/** Test-scoped: the only place that can skip, which is why it exists separately. */
export async function provideSql(
  { sqlConnection }: SqlWorkerFixtures,
  use: (value: Knex) => Promise<void>,
  testInfo: { skip(condition: boolean, description: string): void },
): Promise<void> {
  if (!sqlConnection.sql) {
    skipWithReason(testInfo, `[db] ${sqlConnection.reason ?? 'no SQL connection'}`);
    return;
  }
  await use(sqlConnection.sql);
}
