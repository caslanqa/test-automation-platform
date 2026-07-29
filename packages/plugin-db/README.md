# @pwtap/plugin-db

Database testing for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) —
query assertions, seed/reset, and migration verification, across PostgreSQL, MySQL, MariaDB and SQLite (through
Knex) plus MongoDB.

[![npm](https://img.shields.io/npm/v/@pwtap/plugin-db)](https://www.npmjs.com/package/@pwtap/plugin-db)

## Install

```bash
npx create-pwtap add db
npm i -D pg      # and the driver for whichever engine you run
```

## Use

```ts
import { test, expect } from '@fixtures';

test.use({ db: { client: 'pg', connection: process.env.DB_CONNECTION_STRING! } });

test('the order was written', async ({ request, sql }) => {
  await request.post('/orders', { data: { sku: 'x' } });
  expect(await sql('orders').where({ sku: 'x' }).first()).toBeTruthy();
});
```

`sql` is a raw Knex instance and `mongo` a raw MongoDB `Db` — no wrapper, because you already know these
clients and a unified "database" API over a relational and a document model would leak.

A database that is unreachable or unconfigured **skips** the test with the reason rather than failing it, the
same way an absent device does.

Full guide, including the worker-scope rules and the migration flow for both engines:
[`docs/DB_TESTING.md`](./docs/DB_TESTING.md).

## License

MIT
