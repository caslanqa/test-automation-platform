# Database testing

Two fixture families, both handing you the real client rather than a wrapper:

| Fixture | Option    | What you get                                                     | Engines                            |
| ------- | --------- | ---------------------------------------------------------------- | ---------------------------------- |
| `sql`   | `db`      | a [Knex](https://knexjs.org) instance                            | PostgreSQL, MySQL, MariaDB, SQLite |
| `mongo` | `mongoDb` | a MongoDB [`Db`](https://mongodb.github.io/node-mongodb-native/) | MongoDB                            |

There is no unified "database" API on purpose. Relational and document models differ at the root, and a common
layer over both would leak in exactly the places you need precision. You already know these two clients.

## Configure

```ts
import { test, expect } from '@fixtures';

// Top level of the file, NOT inside describe — see "Worker scope" below.
test.use({
  db: { client: 'pg', connection: process.env.DB_CONNECTION_STRING! },
  mongoDb: {
    connection: process.env.MONGO_CONNECTION_STRING!,
    database: process.env.MONGO_DATABASE!,
  },
});

test('the order was written', async ({ request, sql }) => {
  await request.post('/orders', { data: { sku: 'x' } });
  expect(await sql('orders').where({ sku: 'x' }).first()).toBeTruthy();
});
```

`client` takes `pg`, `mysql`, `mariadb`, `sqlite3` or `better-sqlite3`. MariaDB has no Knex client of its own —
it speaks the MySQL wire protocol, so naming `mariadb` here uses `mysql2` underneath.

Install only the driver for the engine you run; all three are optional peers:

```bash
npm i -D pg              # PostgreSQL
npm i -D mysql2          # MySQL or MariaDB
npm i -D better-sqlite3  # SQLite — a native module, so it needs a build toolchain
```

## Unreachable means skipped

A database that is not there, or not configured, **skips** the test with the reason — it never fails it. That is
the same call the mobile plugins make for an absent device: a missing environment is not a broken test.

The reason is printed next to the skip, so a run does not just show an unexplained gap:

```
  ↷ skipped — [db] the pg driver is not installed — run `npm i -D pg`
  -  1 tests/db/example.db.spec.ts:20:1 › a row appears after the action
```

That is the first one a fresh project sees, since the drivers are optional peers. Once the driver is in, an
absent server reads `could not reach the pg database: connect ECONNREFUSED 127.0.0.1:5432`.

**Configure it in `env/environments.json`, not in the test file.** The fixtures read `DB_CLIENT`,
`DB_CONNECTION_STRING`, `MONGO_CONNECTION_STRING` and `MONGO_DATABASE` themselves, so a project needs no
`test.use({ db })` at all. Set the option only to override one file:

```ts
test.use({ db: { client: 'better-sqlite3', connection: { filename: ':memory:' } } });
```

An option wins over the env, and anything it leaves out falls back to the env. That is the opposite of the mobile
plugins, where `MOBILE_INSPECTOR_DEVICE` beats the test's own device: there the env exists to retarget a whole run
without editing tests, whereas here the env _is_ the project's configuration and a test that names a connection
outright means it.

Do not read `process.env` in the test file to fill the option in — the example used to, and that was the bug
behind a reported `no pg connection configured` while the value sat filled in inside `env/environments.json`. A
module's top level is evaluated at a moment that depends on how the run was launched, so the read can happen
before the config's `loadEnv()` has reached it. A fixture body cannot run before the config.

**Unconfigured counts as unreachable.** `create` writes the four env keys in empty for you to fill, so an empty
client, connection or database is a skip with the key named — never a failure, and never the driver's own words
for it. If you copy the option out of the example, keep the `||`: `??` falls back only on null and undefined, so
`process.env.DB_CLIENT ?? 'pg'` hands an empty string straight through.

It is also recorded as a `skip` annotation, which is where the HTML and JSON reports read it from. The line
exists because those reports are the _only_ place Playwright puts it — `list` and `line` print the dash and the
test name and nothing else.

## Worker scope, and what it costs

Both connections are worker-scoped, so one pool serves every test a worker runs and Playwright closes it when
the worker ends. No teardown project is involved. Two consequences:

- **Set the option at the top level of a file.** Playwright rejects it inside `describe` with
  _"Cannot use({ db }) in a describe group, because it forces a new worker."_
- **Two files with different values run in different workers**, one connection each. That is the price of
  pooling per worker; a suite that wants a single connection should use a single value.

## Reset between tests

```ts
await resetSqlDatabase(sql); // every table except Knex's bookkeeping
await resetSqlDatabase(sql, { tables: ['orders'] }); // just these, in the order given
await resetMongoDatabase(mongo); // every collection except _pwtap_migrations
```

SQL branches on the dialect: `TRUNCATE … RESTART IDENTITY CASCADE` on Postgres, `TRUNCATE` between
`FOREIGN_KEY_CHECKS` toggles on MySQL/MariaDB, and `DELETE FROM` on SQLite, which has no `TRUNCATE`. Mongo uses
`deleteMany({})` rather than dropping, so your indexes survive — a dropped collection would take a unique index
with it and the next test would pass for the wrong reason.

## Resetting and parallelism

Workers share the database. A worker-scoped connection pools connections, not data, so `resetSqlDatabase(sql)`
in one worker empties the table for **every** worker — including one mid-test. Found the honest way: the example
suite passed on one worker and failed on two.

Pick one of these, in rough order of how far they scale:

- **Own your rows.** Tag the data a test creates with `testInfo.workerIndex` and clear only that. Correct at any
  level of parallelism, and what the scaffolded example does.
- **Run DB tests serially** — `workers: 1` for that project, or `test.describe.serial`. Simple, slower.
- **Give each worker its own database or schema**, keyed on `workerIndex`. Full isolation, most setup.

A blanket reset is right in exactly one situation: a suite that already runs serially.

## Migrations

**SQL is Knex's own system**, wired up and nothing more. The knexfile is `.mjs` while the migrations it loads
are `.ts` — deliberately: Knex's CLI hunts for a TypeScript loader when the _knexfile_ has a `.ts` extension and
prints six `Failed to load external module ts-node/register` lines before succeeding anyway on Node ≥ 22.6,
which strips types natively. The migrations load either way, so the `.ts` extension bought nothing but output
that reads like a stack of failures.

```bash
npm run db:migrate:make add_orders   # writes db/migrations/<timestamp>_add_orders.ts
npm run db:migrate:latest
npm run db:migrate:rollback
npm run db:seed
```

**MongoDB has no equivalent**, so this plugin ships a small runner rather than pulling in a third dependency.
Files in `db/migrations-mongo/` export the same `up(db)` / `down(db)` pair, apply in filename order, and are
recorded in a `_pwtap_migrations` collection:

```bash
npm run db:mongo:migrate
npm run db:mongo:migrate:rollback   # undoes exactly the last one
```

Seeding is where the symmetry stops: Knex has a seed system and MongoDB does not, so a Mongo seed is an ordinary
script using the driver.

## This plugin does not install a database

Just as the mobile plugins do not install a device. Point it at one you already run. For local work:

```yaml
# docker-compose.yml — a convenience, not a requirement
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: pwtap, POSTGRES_DB: app_test }
    ports: ['5432:5432']
  mongo:
    image: mongo:7
    ports: ['27017:27017']
```
