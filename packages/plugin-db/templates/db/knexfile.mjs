/**
 * Knex's own configuration, read by the `db:migrate:*` and `db:seed` scripts.
 *
 * Reads the same env keys the `db` fixture option does, so the CLI and the tests cannot disagree about which
 * database they point at.
 *
 * Deliberately `.mjs` rather than `.ts`, even though the migrations it loads are TypeScript: Knex's CLI hunts
 * for a TypeScript loader when the knexfile itself has a `.ts` extension, printing six
 * "Failed to load external module ts-node/register" lines before succeeding anyway on Node ≥ 22.6, which strips
 * types natively. The migrations load fine either way, so the only thing the `.ts` extension bought was output
 * that reads like a stack of failures. The JSDoc type below gives the same editor checking.
 *
 * @type {import('knex').Knex.Config}
 */

/** MariaDB speaks the MySQL wire protocol, so it uses the mysql2 driver. */
const CLIENT = {
  pg: 'pg',
  postgres: 'pg',
  postgresql: 'pg',
  mysql: 'mysql2',
  mysql2: 'mysql2',
  mariadb: 'mysql2',
  sqlite3: 'better-sqlite3',
  'better-sqlite3': 'better-sqlite3',
};

const client = CLIENT[(process.env.DB_CLIENT ?? 'pg').toLowerCase()] ?? 'pg';

export default {
  client,
  connection: process.env.DB_CONNECTION_STRING ?? '',
  useNullAsDefault: client.includes('sqlite'),
  migrations: { directory: './migrations', extension: 'ts' },
  seeds: { directory: './seeds' },
};
