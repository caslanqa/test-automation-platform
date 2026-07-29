/**
 * Emptying tables between tests, in whatever way the dialect actually supports.
 *
 * Deliberately not one `resetDatabase` over both engines: telling SQL from Mongo would mean sniffing the
 * argument at runtime, which is the artificial common layer this plugin exists without.
 *
 * @example await resetSqlDatabase(sql, { tables: ['orders', 'users'] });
 */
import type { Knex } from 'knex';

export interface ResetSqlOptions {
  /**
   * Tables to empty, in an order that respects your foreign keys where the dialect needs it. Omit to empty
   * every table Knex can see except the migration bookkeeping, which must survive or the next `migrate:latest`
   * would replay everything.
   */
  tables?: string[];
}

const MIGRATION_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);

export async function resetSqlDatabase(sql: Knex, options: ResetSqlOptions = {}): Promise<void> {
  const dialect = String(sql.client.config.client);
  const tables = options.tables ?? (await discoverTables(sql, dialect));
  if (tables.length === 0) {
    return;
  }
  if (options.tables) {
    // Only when the caller named them: a discovered table exists by definition. A name that does not is a typo
    // or a migration that never ran, and the driver's own answer for it is an unexplained protocol-level error.
    const missing: string[] = [];
    for (const table of options.tables) {
      if (!(await sql.schema.hasTable(table))) {
        missing.push(table);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `[db] cannot reset ${missing.map(name => `"${name}"`).join(', ')}: no such table. ` +
          'Run your migrations first (npm run db:migrate:latest), or check the name.',
      );
    }
  }
  if (dialect === 'pg') {
    // One statement: CASCADE settles the foreign keys and RESTART IDENTITY makes the next inserted id
    // predictable, which is what makes a fixture's expected values stable.
    const list = tables.map(table => sql.ref(table).toQuery()).join(', ');
    await sql.raw(`truncate table ${list} restart identity cascade`);
    return;
  }
  if (dialect === 'mysql2' || dialect === 'mysql') {
    // MySQL/MariaDB have no CASCADE for TRUNCATE, so the checks come off for the duration instead.
    await sql.transaction(async trx => {
      await trx.raw('set foreign_key_checks = 0');
      for (const table of tables) {
        await trx.raw(`truncate table ${trx.ref(table).toQuery()}`);
      }
      await trx.raw('set foreign_key_checks = 1');
    });
    return;
  }
  // SQLite has no TRUNCATE at all. DELETE FROM is the equivalent; the sequence table is reset separately so
  // autoincrement ids start over as they do elsewhere.
  for (const table of tables) {
    await sql(table).del();
  }
  const hasSequences = await sql.schema.hasTable('sqlite_sequence');
  if (hasSequences) {
    await sql('sqlite_sequence').whereIn('name', tables).del();
  }
}

/** Every table in the current schema, minus Knex's own bookkeeping. */
async function discoverTables(sql: Knex, dialect: string): Promise<string[]> {
  if (dialect === 'pg') {
    const result = await sql.raw<{ rows: { tablename: string }[] }>(
      'select tablename from pg_tables where schemaname = current_schema()',
    );
    return result.rows.map(row => row.tablename).filter(name => !MIGRATION_TABLES.has(name));
  }
  if (dialect === 'mysql2' || dialect === 'mysql') {
    const [rows] = await sql.raw<[{ table_name?: string; TABLE_NAME?: string }[]]>(
      'select table_name from information_schema.tables where table_schema = database()',
    );
    return rows
      .map(row => row.table_name ?? row.TABLE_NAME ?? '')
      .filter(name => name && !MIGRATION_TABLES.has(name));
  }
  const rows = await sql
    .select<{ name: string }[]>('name')
    .from('sqlite_master')
    .where('type', 'table')
    .whereNot('name', 'like', 'sqlite_%');
  return rows.map(row => row.name).filter(name => !MIGRATION_TABLES.has(name));
}
