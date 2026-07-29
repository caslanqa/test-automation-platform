/**
 * Opening a SQL connection, and proving it works before a test relies on it.
 *
 * Returns a reason instead of throwing, because an unreachable database must skip a test rather than fail it
 * (the same call the mobile plugins make for an absent device) — and the decision to skip belongs to a
 * test-scoped fixture, which is the only place `testInfo` exists.
 *
 * @example const opened = await createSqlConnection({ client: 'pg', connection: process.env.DB_CONNECTION_STRING! });
 */
import knexFactory, { type Knex } from 'knex';

/** Dialects this plugin accepts, in the spelling a user thinks in. */
export type SqlClient = 'pg' | 'mysql' | 'mariadb' | 'sqlite3' | 'better-sqlite3';

export interface SqlConnectionOptions {
  client: SqlClient;
  /** A connection string, or Knex's own connection object — passed through untouched. */
  connection: string | Knex.StaticConnectionConfig;
  pool?: { min?: number; max?: number };
}

export type SqlConnectionResult = { sql: Knex } | { reason: string };

/**
 * MariaDB has no Knex client of its own: it speaks the MySQL wire protocol, so `mysql2` drives it. Accepting
 * `'mariadb'` and translating here means a user names the engine they actually run, not the driver it happens
 * to share.
 */
const KNEX_CLIENT: Record<SqlClient, string> = {
  pg: 'pg',
  mysql: 'mysql2',
  mariadb: 'mysql2',
  sqlite3: 'sqlite3',
  'better-sqlite3': 'better-sqlite3',
};

/** SQLite takes a file, so Knex needs `useNullAsDefault` or it warns on every insert. */
const isSqlite = (client: SqlClient): boolean =>
  client === 'sqlite3' || client === 'better-sqlite3';

export async function createSqlConnection(
  options: SqlConnectionOptions,
): Promise<SqlConnectionResult> {
  let sql: Knex;
  try {
    sql = knexFactory({
      client: KNEX_CLIENT[options.client],
      connection: options.connection,
      pool: options.pool,
      useNullAsDefault: isSqlite(options.client),
      // Knex logs pool failures straight to the console. Since an unreachable database is a SKIP here, not a
      // failure, that printed a stack trace next to a skipped test and read like something had gone wrong.
      // The reason is returned instead, and the fixture puts it in the skip message.
      log: { warn: noop, error: noop, deprecate: noop, debug: noop },
    });
  } catch (error) {
    // A missing driver package lands here — the drivers are optional peers, so this is a normal outcome.
    return { reason: `could not create a ${options.client} connection: ${message(error)}` };
  }
  try {
    await sql.raw('select 1');
  } catch (error) {
    await sql.destroy().catch(() => undefined);
    return { reason: `could not reach the ${options.client} database: ${message(error)}` };
  }
  return { sql };
}

export async function closeSqlConnection(sql: Knex): Promise<void> {
  await sql.destroy().catch(() => undefined);
}

function noop(): void {
  /* see the `log` option above */
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
