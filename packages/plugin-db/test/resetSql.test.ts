/**
 * `resetSqlDatabase` on every dialect it claims to support.
 *
 * This is the one place in the plugin where each dialect gets DIFFERENT SQL — `TRUNCATE … RESTART IDENTITY
 * CASCADE` on Postgres, `TRUNCATE` between `FOREIGN_KEY_CHECKS` toggles on MySQL/MariaDB, `DELETE FROM` plus a
 * `sqlite_sequence` clear on SQLite — and `discoverTables` reads a different catalog for each. Knex using one
 * code path for its query builder says nothing about any of that, which is why "Postgres proves the rest" was
 * the wrong call and each engine is exercised here.
 *
 * Each dialect skips on its own when unreachable, so this costs nothing without databases:
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=pwtap -e POSTGRES_DB=pwtap_test -p 55432:5432 postgres:16-alpine
 *   docker run -d --name my -e MYSQL_ROOT_PASSWORD=pwtap -e MYSQL_DATABASE=pwtap_test -p 53306:3306 mysql:8
 *   docker run -d --name ma -e MARIADB_ROOT_PASSWORD=pwtap -e MARIADB_DATABASE=pwtap_test -p 53307:3306 mariadb:11
 *   npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Knex } from 'knex';

import { resetSqlDatabase } from '../src/core/resetSql.js';
import {
  closeSqlConnection,
  createSqlConnection,
  type SqlClient,
} from '../src/core/sqlConnection.js';

interface Target {
  client: SqlClient;
  connection: string | Record<string, unknown>;
}

const sqliteFile = path.join(os.tmpdir(), `pwtap-reset-${process.pid}.sqlite`);

const TARGETS: Target[] = [
  {
    client: 'pg',
    connection: process.env.PWTAP_PG_URI ?? 'postgres://postgres:pwtap@127.0.0.1:55432/pwtap_test',
  },
  {
    client: 'mysql',
    connection: {
      host: '127.0.0.1',
      port: Number(process.env.PWTAP_MYSQL_PORT ?? 53306),
      user: 'root',
      password: 'pwtap',
      database: 'pwtap_test',
    },
  },
  {
    client: 'mariadb',
    connection: {
      host: '127.0.0.1',
      port: Number(process.env.PWTAP_MARIADB_PORT ?? 53307),
      user: 'root',
      password: 'pwtap',
      database: 'pwtap_test',
    },
  },
  // No server to reach, so this one always runs — and it is the dialect with the most special-casing.
  { client: 'better-sqlite3', connection: { filename: sqliteFile } },
];

/** A parent and a child, so the foreign key each dialect handles differently is actually present. */
async function seedSchema(sql: Knex): Promise<number> {
  await sql.schema.dropTableIfExists('orders');
  await sql.schema.dropTableIfExists('customers');
  await sql.schema.createTable('customers', table => {
    table.increments('id');
    table.string('name').notNullable();
  });
  await sql.schema.createTable('orders', table => {
    table.increments('id');
    table.integer('customer_id').unsigned().references('id').inTable('customers');
  });
  await sql('customers').insert({ name: 'ada' });
  const customer = await sql('customers').first();
  const customerId = Number(customer?.id);
  await sql('orders').insert([{ customer_id: customerId }, { customer_id: customerId }]);
  return customerId;
}

const count = async (sql: Knex, table: string): Promise<number> =>
  Number((await sql(table).count('* as n').first())?.n ?? -1);

for (const target of TARGETS) {
  test(`${target.client}: reset empties tables, restarts identity and spares the migration history`, async t => {
    const opened = await createSqlConnection({
      client: target.client,
      connection: target.connection as never,
    });
    if ('reason' in opened) {
      t.skip(`no ${target.client} to reach — ${opened.reason}`);
      return;
    }
    const { sql } = opened;
    try {
      await seedSchema(sql);
      assert.equal(await count(sql, 'orders'), 2, 'the fixture data should be there to begin with');

      // Named, child first: the order a caller controls, and the one a foreign key demands.
      await resetSqlDatabase(sql, { tables: ['orders', 'customers'] });
      assert.equal(await count(sql, 'orders'), 0);
      assert.equal(await count(sql, 'customers'), 0);

      // The whole reason Postgres uses RESTART IDENTITY and SQLite clears sqlite_sequence: a fixture's
      // expected ids are only stable if the counter goes back too.
      await sql('customers').insert({ name: 'grace' });
      assert.equal(Number((await sql('customers').first())?.id), 1, 'the next id must start over');

      // The discovery path reads a different catalog per dialect, and must leave Knex's own tables alone —
      // emptying them would make the next `migrate:latest` replay every migration.
      await sql.schema.dropTableIfExists('knex_migrations');
      await sql.schema.createTable('knex_migrations', table => {
        table.increments('id');
        table.string('name');
      });
      await sql('knex_migrations').insert({ name: '0001_probe' });
      await sql('customers').insert({ name: 'alan' });

      await resetSqlDatabase(sql);

      assert.equal(await count(sql, 'customers'), 0, 'discovery should have found and emptied it');
      assert.equal(
        await count(sql, 'knex_migrations'),
        1,
        'and must never empty the migration history',
      );
    } finally {
      await closeSqlConnection(sql);
      if (target.client === 'better-sqlite3') {
        fs.rmSync(sqliteFile, { force: true });
      }
    }
  });
}

test('a named table that does not exist is explained, not left to the driver', async () => {
  const opened = await createSqlConnection({
    client: 'better-sqlite3',
    connection: { filename: sqliteFile },
  });
  // SQLite needs no server, so there is no skip path here to write — asserting it opened is the whole check.
  assert.ok(!('reason' in opened), 'a file-backed SQLite connection should always open');
  try {
    // Found live: a table no migration had created yet surfaced as a raw driver error behind a
    // pg-protocol stack trace, which says nothing about what to do.
    await assert.rejects(
      () => resetSqlDatabase(opened.sql, { tables: ['nope'] }),
      /no such table.*migrations/s,
    );
  } finally {
    await closeSqlConnection(opened.sql);
    fs.rmSync(sqliteFile, { force: true });
  }
});
