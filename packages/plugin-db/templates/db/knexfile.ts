/**
 * Knex's own configuration, read by the `db:migrate:*` and `db:seed` scripts.
 *
 * Reads the same env keys the `db` fixture option does, so the CLI and the tests cannot disagree about which
 * database they are pointed at.
 */
import type { Knex } from 'knex';

/** MariaDB speaks the MySQL wire protocol, so it uses the mysql2 driver. */
const CLIENT: Record<string, string> = {
  pg: 'pg',
  postgres: 'pg',
  mysql: 'mysql2',
  mariadb: 'mysql2',
  sqlite3: 'better-sqlite3',
};

const client = CLIENT[process.env.DB_CLIENT?.toLowerCase() ?? 'pg'] ?? 'pg';

const config: Knex.Config = {
  client,
  connection: process.env.DB_CONNECTION_STRING ?? '',
  useNullAsDefault: client.includes('sqlite'),
  migrations: { directory: './migrations', extension: 'ts' },
  seeds: { directory: './seeds' },
};

export default config;
