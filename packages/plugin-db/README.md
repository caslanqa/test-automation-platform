# @pwtap/plugin-db

Database testing for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) —
query assertions, seed/reset, and migration verification, across PostgreSQL, MySQL, MariaDB and SQLite (through
Knex) plus MongoDB.

[![npm](https://img.shields.io/npm/v/@pwtap/plugin-db)](https://www.npmjs.com/package/@pwtap/plugin-db)

| Fixture | You get             | Engines                            |
| ------- | ------------------- | ---------------------------------- |
| `sql`   | a raw Knex instance | PostgreSQL, MySQL, MariaDB, SQLite |
| `mongo` | a raw MongoDB `Db`  | MongoDB                            |

No wrapper and no unified "database" API: you already know these clients, and a common layer over a relational and
a document model would leak in exactly the places you need precision.

## 1. Install

```bash
npx @pwtap/create add db
```

Then the driver for the one engine you run — they are optional peers, so you install none you don't need:

| Your database | `DB_CLIENT`      | Install                   |
| ------------- | ---------------- | ------------------------- |
| PostgreSQL    | `pg`             | `npm i -D pg`             |
| MySQL         | `mysql`          | `npm i -D mysql2`         |
| MariaDB       | `mariadb`        | `npm i -D mysql2`         |
| SQLite        | `better-sqlite3` | `npm i -D better-sqlite3` |
| MongoDB       | —                | ships installed           |

## 2. Configure

In `env/environments.json` — not in your test files:

```json
{
  "common": {
    "DB_CLIENT": "pg",
    "DB_CONNECTION_STRING": "postgresql://app:secret@localhost:5432/app_test",
    "MONGO_CONNECTION_STRING": "mongodb://localhost:27017",
    "MONGO_DATABASE": "app_test"
  }
}
```

The fixtures read those keys themselves, so no `test.use({ db })` is needed. Set the option only to override one
file — `test.use({ db: { client: 'better-sqlite3', connection: { filename: ':memory:' } } })` — and it wins, with
anything it leaves out still coming from the env.

## 3. Write

These fixtures belong **inside** your API and UI tests, because the usual question is the one after an action:
_did the right row appear?_

```ts
import { expect, test } from '@fixtures';

test('posting an order writes the row', async ({ request, sql }) => {
  await request.post('/orders', { data: { sku: 'ABC-1' } });

  const order = await sql('orders').where({ sku: 'ABC-1' }).first();
  expect(order).toBeTruthy();
  expect(order.status).toBe('pending');
});
```

## 4. Run

```bash
npx playwright test              # ordinary tests, no separate project
npx playwright test e2e/db       # just the DB-only specs
```

A database that is unreachable **or unconfigured** skips the test with the reason rather than failing it, the same
way an absent device does — and the reason is printed next to the skip, not only buried in a report:

```
↷ skipped — [db] the pg driver is not installed — run `npm i -D pg`
```

## Full guide

[`docs/DB_TESTING.md`](./docs/DB_TESTING.md) walks the whole path in order: driver, configuration, writing,
running, worker-scope rules, keeping tests independent under parallelism, migrations and seeds for both engines,
what each reporter records, and a table of every skip message with what to do about it.

## License

MIT
