# Database testing

Two fixture families, each handing you the real client rather than a wrapper:

| Fixture | You get                                                          | Engines                            |
| ------- | ---------------------------------------------------------------- | ---------------------------------- |
| `sql`   | a [Knex](https://knexjs.org) instance                            | PostgreSQL, MySQL, MariaDB, SQLite |
| `mongo` | a MongoDB [`Db`](https://mongodb.github.io/node-mongodb-native/) | MongoDB                            |

There is no unified "database" API on purpose: relational and document models differ at the root, and a common
layer over both would leak in exactly the places you need precision.

Read this front to back once — it follows the order you will actually do things.

1. [Install the driver for your engine](#1-install-the-driver-for-your-engine)
2. [Configure the connection](#2-configure-the-connection)
3. [Write a test](#3-write-a-test)
4. [Run it](#4-run-it)
5. [Keep tests independent](#5-keep-tests-independent)
6. [Migrations and seeds](#6-migrations-and-seeds)
7. [Read the results](#7-read-the-results)
8. [Every skip message, and what to do](#8-every-skip-message-and-what-to-do)

---

## 1. Install the driver for your engine

This plugin ships Knex and the MongoDB driver. The **SQL drivers are optional peers**, so you install only the
one engine you run rather than three you don't:

| Your database | `DB_CLIENT`      | Install                     | Notes                                                  |
| ------------- | ---------------- | --------------------------- | ------------------------------------------------------ |
| PostgreSQL    | `pg`             | `npm i -D pg`               |                                                        |
| MySQL         | `mysql`          | `npm i -D mysql2`           |                                                        |
| MariaDB       | `mariadb`        | `npm i -D mysql2`           | MariaDB speaks the MySQL wire protocol                 |
| SQLite        | `better-sqlite3` | `npm i -D better-sqlite3`   | Native module — needs a C++ build toolchain            |
| MongoDB       | —                | nothing, it ships installed | Configured through the `MONGO_*` keys, not `DB_CLIENT` |

Two spellings that trip people up: write `mariadb`, not `mysql2` — you name the engine you run, and the plugin
picks the driver. And write `pg`, not `postgres` or `postgresql`; an unknown spelling is rejected by name.

Skip this step and the first run tells you so, naming the command:

```
↷ skipped — [db] the pg driver is not installed — run `npm i -D pg`
```

## 2. Configure the connection

**Configuration lives in `env/environments.json`, not in your test files.** The fixtures read these four keys
themselves:

| Key                       | Holds                                    | Example                                           |
| ------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `DB_CLIENT`               | which SQL engine                         | `pg`                                              |
| `DB_CONNECTION_STRING`    | where it is                              | `postgresql://app:secret@localhost:5432/app_test` |
| `MONGO_CONNECTION_STRING` | where MongoDB is                         | `mongodb://localhost:27017`                       |
| `MONGO_DATABASE`          | which database (required, not the URI's) | `app_test`                                        |

Put them in `common` when every environment shares a database, or inside an environment block when they differ:

```json
{
  "common": {
    "DB_CLIENT": "pg",
    "DB_CONNECTION_STRING": "postgresql://app:secret@localhost:5432/app_test"
  },
  "environments": {
    "staging": { "DB_CONNECTION_STRING": "postgresql://app:secret@staging-db:5432/app" }
  }
}
```

That is all. A test file needs **no `test.use({ db })`** — the example ships without one.

### Overriding for one file

Set the option when a single file needs its own database — an in-memory SQLite for a pure query test, say:

```ts
test.use({ db: { client: 'better-sqlite3', connection: { filename: ':memory:' } } });
```

The option wins over the env, and anything it leaves out still falls back to the env. This is deliberately the
opposite of the mobile plugins, where `MOBILE_INSPECTOR_DEVICE` beats the test's own device: there the env exists
to retarget a whole run without editing tests, whereas here the env **is** the project's configuration and a test
that names a connection outright means it.

> **Do not read `process.env` in a test file to fill the option in.** The example used to, and it caused a
> reported `no pg connection configured` while the value sat filled in inside `env/environments.json`: a module's
> top level is evaluated at a moment that depends on how the run was launched, so the read can happen before the
> config's `loadEnv()` has reached it. A fixture body cannot run before the config, which is why the reading moved
> there.

### Worker scope, and what it costs

Both connections are **worker-scoped**: one pool serves every test a worker runs, and Playwright closes it when
the worker ends. No teardown project is involved. Two consequences:

- **Set the option at the top level of a file**, never inside `describe`. Playwright refuses it there with
  _"Cannot use({ db }) in a describe group, because it forces a new worker."_
- **Two files with different values run in different workers**, one connection each. That is the price of pooling
  per worker; a suite that wants a single connection should use a single value.

## 3. Write a test

The most common real need is the one after an action — _did the right row appear?_ So these fixtures are used
**inside** your API and UI tests, not in a separate suite:

```ts
import { expect, test } from '@fixtures';

test('posting an order writes the row', async ({ request, sql }) => {
  await request.post('/orders', { data: { sku: 'ABC-1' } });

  const order = await sql('orders').where({ sku: 'ABC-1' }).first();
  expect(order).toBeTruthy();
  expect(order.status).toBe('pending');
});
```

`sql` is a raw Knex instance, so the whole query builder is yours: `.where()`, `.join()`, `.count()`,
`sql.raw(…)`, transactions, schema inspection. MongoDB works the same way with the real `Db`:

```ts
test('the profile document is written as expected', async ({ request, mongo }) => {
  await request.post('/profiles', { data: { handle: 'ada' } });

  const doc = await mongo.collection('profiles').findOne({ handle: 'ada' });
  expect(doc).toMatchObject({ handle: 'ada', active: true });
});
```

A DB-only file works too — migration checks, a query you want pinned. Put it under your tests folder in `db/`
(`e2e/db/` if you scaffolded with `--tests-dir e2e`) and name it `*.spec.ts` so the runner collects it. There is
no `db` Playwright project by design; a DB-only spec costs nothing in the browser project, because Playwright
starts a browser only for a test that asks for `page`.

**Tag the rows you create** — see [step 5](#5-keep-tests-independent) before you write a second test.

## 4. Run it

Nothing special: they are ordinary tests.

```bash
npx playwright test                    # everything
npx playwright test e2e/db             # just the DB-only specs
npx playwright test e2e/db/orders.spec.ts --workers=1
npx playwright test -g "writes the row"
```

A run with no database reachable is not a failure — every affected test **skips with the reason on the line above
it**:

```
Running 2 tests using 1 worker

  ↷ skipped — [db] no MongoDB connection configured — set `mongoDb.connection` (MONGO_CONNECTION_STRING in a scaffolded project)
  -  2 [chromium] › e2e/db/example.db.spec.ts:63:1 › a document is written as expected

  1 skipped
  1 passed (899ms)
```

That is the same call the mobile plugins make for an absent device: a missing environment is not a broken test.
**Unconfigured counts as unreachable** — `create` writes the four keys in empty for you to fill, so an empty
client, connection or database skips with the key named rather than failing.

## 5. Keep tests independent

```ts
import { resetMongoDatabase, resetSqlDatabase } from '@pwtap/plugin-db';

await resetSqlDatabase(sql); // every table except Knex's bookkeeping
await resetSqlDatabase(sql, { tables: ['orders', 'customers'] }); // just these, in the order given
await resetMongoDatabase(mongo); // every collection except _pwtap_migrations
```

The helpers come from the package, not from `@fixtures` — the barrel merges test objects and matchers, not
arbitrary exports.

SQL branches on the dialect: `TRUNCATE … RESTART IDENTITY CASCADE` on Postgres, `TRUNCATE` between
`FOREIGN_KEY_CHECKS` toggles on MySQL/MariaDB, and `DELETE FROM` plus a `sqlite_sequence` clear on SQLite, which
has no `TRUNCATE`. Mongo uses `deleteMany({})` rather than dropping, so your indexes survive — a dropped
collection would take a unique index with it and the next test would pass for the wrong reason.

### The trap: workers share the database

A worker-scoped connection pools **connections, not data**. So `resetSqlDatabase(sql)` in one worker empties the
table for every other worker, including one mid-test. Found the honest way: the example suite passed on one worker
and failed on two.

Pick one, in rough order of how far it scales:

- **Own your rows.** Tag what a test creates with `testInfo.workerIndex` and clear only that. Correct at any level
  of parallelism, and what the scaffolded example does:

  ```ts
  const emailFor = (workerIndex: number): string => `demo-w${workerIndex}@example.com`;

  test('the row an action creates is really there', async ({ sql }, testInfo) => {
    const email = emailFor(testInfo.workerIndex);
    await sql('users').insert({ email });
    expect(await sql('users').where({ email }).first()).toBeTruthy();
  });
  ```

- **Run DB tests serially** — `workers: 1` for that project, or `test.describe.serial`. Simple, slower.
- **Give each worker its own database or schema**, keyed on `workerIndex`. Full isolation, most setup.

A blanket reset is right in exactly one situation: a suite that already runs serially.

## 6. Migrations and seeds

**SQL is Knex's own system**, wired up and nothing more:

```bash
npm run db:migrate:make add_orders   # writes db/migrations/<timestamp>_add_orders.ts
npm run db:migrate:latest
npm run db:migrate:rollback
npm run db:seed                      # runs db/seeds
```

Each migration exports `up` and `down`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('orders', table => {
    table.increments('id');
    table.string('sku').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('orders');
}
```

The knexfile is `.mjs` while the migrations it loads are `.ts`, deliberately: Knex's CLI hunts for a TypeScript
loader when the _knexfile_ has a `.ts` extension and prints six `Failed to load external module ts-node/register`
lines before succeeding anyway on Node ≥ 22.6, which strips types natively. The migrations load either way, so
`.ts` there bought nothing but output that reads like a stack of failures.

**MongoDB has no equivalent**, so this plugin ships a small runner rather than pulling in a third dependency.
Files in `db/migrations-mongo/` export the same `up(db)` / `down(db)` pair, apply in filename order, and are
recorded in a `_pwtap_migrations` collection:

```bash
npm run db:mongo:migrate
npm run db:mongo:migrate:rollback   # undoes exactly the last one
```

Seeding is where the symmetry stops: Knex has a seed system and MongoDB does not, so a Mongo seed is an ordinary
script using the driver.

## 7. Read the results

A skip reason reaches **every** reporter the scaffold configures, each in its own shape:

| Reporter | Where the reason shows up                                          |
| -------- | ------------------------------------------------------------------ |
| `list`   | printed on the line above the skipped test                         |
| `html`   | a `skip` annotation on the test — `npx playwright show-report`     |
| `json`   | `annotations[]` with `type: "skip"` in `test-results/results.json` |
| `allure` | `statusDetails.message` on a `skipped` result in `allure-results/` |

The console line exists because the annotation alone is invisible where people actually watch: `list` and `line`
print a dash and the test name and nothing else. Both carry it now, so a skipped DB test is never an unexplained
gap.

```bash
npm run report:playwright   # the HTML report
```

Allure results are written to `allure-results/`, but turning them into a report needs the Allure CLI, which the
scaffold does not install — `npm i -D allure-commandline`, then
`npx allure generate allure-results --clean -o allure-report && npx allure open allure-report`.

Checking a skip in CI without opening a report:

```bash
node -e "const r=require('./test-results/results.json');
  const walk=s=>[...(s.specs||[]),...(s.suites||[]).flatMap(walk)];
  r.suites.flatMap(walk).flatMap(s=>s.tests).flatMap(t=>t.annotations||[])
    .filter(a=>a.type==='skip').forEach(a=>console.log(a.description))"
```

## 8. Every skip message, and what to do

Each of these is a measured message, not an invented one.

| Message                                                     | Means                              | Do                                                                 |
| ----------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `the pg driver is not installed — run npm i -D pg`          | optional peer missing              | run that command ([step 1](#1-install-the-driver-for-your-engine)) |
| `no SQL client configured — set db.client to one of …`      | `DB_CLIENT` is empty               | set it in `env/environments.json`                                  |
| `unknown SQL client postgresql — use one of …`              | wrong spelling                     | use `pg`, `mysql`, `mariadb`, `sqlite3` or `better-sqlite3`        |
| `no pg connection configured — set db.connection`           | `DB_CONNECTION_STRING` is empty    | fill it in                                                         |
| `could not reach the pg database: connect ECONNREFUSED …`   | nothing is listening there         | start the database, check host and port                            |
| `no MongoDB connection configured — set mongoDb.connection` | `MONGO_CONNECTION_STRING` is empty | fill it in                                                         |
| `no MongoDB database configured — set mongoDb.database`     | `MONGO_DATABASE` is empty          | name the database; the URI's own is not assumed                    |
| `MongoDB rejected the connection string …`                  | malformed URI                      | it must start `mongodb://` or `mongodb+srv://`                     |
| `could not reach MongoDB at …: connect ECONNREFUSED …`      | nothing is listening there         | start MongoDB, check host and port                                 |

Two errors that are **not** skips, because they are mistakes rather than a missing environment:

- _"Cannot use({ db }) in a describe group, because it forces a new worker."_ — move `test.use` to the top level
  of the file ([worker scope](#worker-scope-and-what-it-costs)).
- `resetSqlDatabase` naming a table that does not exist — run your migrations first
  (`npm run db:migrate:latest`).

## This plugin does not install a database

Just as the mobile plugins do not install a device. Point it at one you already run. For local work:

```yaml
# docker-compose.yml — a convenience, not a requirement
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: secret, POSTGRES_USER: app, POSTGRES_DB: app_test }
    ports: ['5432:5432']
  mongo:
    image: mongo:7
    ports: ['27017:27017']
```

```bash
docker compose up -d
npm run db:migrate:latest
npx playwright test e2e/db
```
