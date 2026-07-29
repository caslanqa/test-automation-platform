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
  isUnconfigured,
  type SqlClient,
  type SqlConnectionOptions,
} from './core/sqlConnection.js';
import { skipWithReason } from './skip.js';

export interface SqlOptions {
  /**
   * Which engine and where. Omit either field and the matching DB_* env key fills it, so a project configured
   * through `env/environments.json` needs no `test.use({ db })` at all.
   */
  db?: Partial<SqlConnectionOptions>;
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

/**
 * Fill whatever the option left empty from the DB_* env keys.
 *
 * Read here, inside the worker fixture, rather than in the test file's module scope. The scaffolded example used
 * to do the reading itself — `process.env.DB_CLIENT || 'pg'` in `test.use({ … })` — and module scope is evaluated
 * at a moment that depends on the harness, so a run whose config-side `loadEnv()` had not reached the test module
 * saw both keys empty and skipped with `no pg connection configured` while the values sat in
 * `env/environments.json`. A fixture body runs after the config, always.
 *
 * The option WINS over the env, the opposite of the mobile plugins' device: there the env exists to retarget a
 * whole run without editing tests, whereas here the env IS the project's configuration and a test that names a
 * connection outright means it.
 */
function resolveSqlOptions(db: Partial<SqlConnectionOptions> = {}): SqlConnectionOptions {
  // Cast on the env value only: an unknown spelling is rejected by name downstream, which is where the reader
  // gets told what the accepted ones are.
  const envClient = (process.env.DB_CLIENT ?? '').trim() as SqlClient;
  const envConnection = (process.env.DB_CONNECTION_STRING ?? '').trim();
  return {
    ...db,
    client: db.client !== undefined && !isUnconfigured(db.client) ? db.client : envClient,
    connection:
      db.connection !== undefined && !isUnconfigured(db.connection) ? db.connection : envConnection,
  };
}

/** Worker-scoped: one connection for every test this worker runs. */
export async function openSqlConnection(
  { db }: SqlOptions,
  use: (value: SqlConnection) => Promise<void>,
): Promise<void> {
  const opened = await createSqlConnection(resolveSqlOptions(db));
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
