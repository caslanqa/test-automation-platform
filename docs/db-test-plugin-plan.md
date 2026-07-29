# M6 — `@pwtap/plugin-db`

Database testing: query + assertion, seed/reset, and migration verification, across PostgreSQL, MySQL,
MariaDB and SQLite (through Knex) plus MongoDB (through the official driver).

## Why

Every test type the platform has — UI, API, Maestro/Appium — is a fixture that talks to an external system,
and none of them opens a database. The most common real need is the one after an action: _did the right row
appear?_ This milestone covers that, plus the two things that make it repeatable — resetting state between
tests, and proving migrations apply and roll back.

## Decisions

1. **Two independent fixture families, not one universal API.** Relational and document models differ at the
   root; a common layer over both would leak. Same call as Appium's "raw driver, no curated facade".
   - SQL: option `db` (`test.use({ db: { client: 'pg' | 'mysql' | 'mariadb' | 'sqlite3', connection } })`) →
     fixture `sql` is a raw Knex instance. Knex is already a callable query builder
     (`sql('users').where({ id }).first()`), and MariaDB connects wire-compatibly through `mysql2`.
   - MongoDB: option `mongoDb` (`test.use({ mongoDb: { connection, database } })`) → fixture `mongo` is a raw
     `Db` instance (`mongo.collection('users').find({ … }).toArray()`).
   - The Appium lesson — never name an option the same as its fixture — is applied up front: `db` ≠ `sql`,
     `mongoDb` ≠ `mongo`, and all four differ from every other plugin's names, so one barrel merges them all.

2. **Connections are worker-scoped, not per-test locked.** A device is exclusive; a database connection is
   pooled, and Knex and MongoClient each manage their own pool. So one instance per worker, shared by that
   worker's tests, torn down by Playwright itself — no `*-teardown` project, unlike Maestro and Appium.

   **Two consequences the implementation must respect** (verified against Playwright's fixture docs):
   - A worker-scoped fixture may only depend on worker-scoped things, so the `db` and `mongoDb` options must
     be declared `{ option: true, scope: 'worker' }` as well. A worker option can be set in the config or at
     the top level of a file, **not** inside `describe`.
   - Two files that set different `db` values run in **different workers**, one connection each. That is the
     price of pooling per worker and it is the right default; a suite that wants one connection should use one
     value.

3. **Unreachable means skip, never fail** — the same philosophy as "no device, skip". A worker fixture has no
   `testInfo`, so it cannot skip by itself; **that is why the connection and the skip are two fixtures**: the
   worker-scoped one yields `{ instance?, reason? }` after a `SELECT 1` / `ping`, and a thin test-scoped
   fixture (`sql` / `mongo`) either hands over the instance or calls `testInfo.skip(reason)`. Stating this
   plainly because the first draft of this plan asked one worker fixture to do both, which cannot work.

4. **Migrations: Knex's own system for SQL, a small runner for Mongo.**
   - SQL is wiring only, no new code: `knexfile.ts` + `db/migrations/*.ts` (`up`/`down`), with npm scripts
     delegating to the Knex CLI.
   - Mongo has no equivalent and gets a small runner rather than a third dependency: files under
     `db/migrations-mongo/` with the same `up(db)` / `down(db)` shape, applied ones tracked in a
     `_pwtap_migrations` collection (prefixed, so it cannot collide with an application's own). Same authoring
     experience, different engine underneath. **This is the only piece with no precedent in the repo, so it
     carries its own unit tests:** pending detection, ordering, idempotency (a second run applies nothing), and
     rollback undoing exactly the last migration.

5. **Reset helpers are thin and engine-specific, and separately named.** `resetSqlDatabase(sql, { tables? })`
   and `resetMongoDatabase(mongo, { collections? })` — two names rather than one overload, because a single
   `resetDatabase` would have to sniff the argument's type at runtime, which is the artificial common layer
   decision 1 rejects. SQL branches on the dialect Knex reports: `TRUNCATE … RESTART IDENTITY CASCADE` for
   Postgres, `SET FOREIGN_KEY_CHECKS` around `TRUNCATE` for MySQL/MariaDB, `DELETE FROM` for SQLite, which has
   no `TRUNCATE`. Mongo calls `deleteMany({})` per collection, or every collection when given none.

6. **Seeding: Knex's own for SQL, a plain script for Mongo.** SQL seeds delegate to the Knex CLI like
   migrations do. MongoDB has no seed framework, so a seed there is an ordinary script using the driver. Said
   explicitly so the "same experience on both engines" expectation stops at migrations, where it holds.

7. **No env-gated Playwright project** — the manifest is shaped like `ai-judge`, not like the mobile plugins.
   The fixtures are used _inside_ API and UI tests ("did the row appear?"), so a separate `db` project would
   get in the way. They merge into the barrel and are available in every test file. Standalone DB-only files
   (migration checks, say) work from the same barrel under `tests/db/`; no gate is needed because an
   unreachable connection already skips.

8. **Dependencies:** `knex` and `mongodb` are plain dependencies, as `webdriverio` is for Appium. The actual
   SQL drivers (`pg`, `mysql2`, `better-sqlite3`) are optional peers, so a user installs only the engine they
   use. Note that `better-sqlite3` is a native module and needs a toolchain to build — worth saying in the docs,
   since decision 1 presents SQLite as first-class.

## Steps

1. **Scaffold `packages/plugin-db`.** `package.json` with the `.` / `./manifest` / `./ensure` exports map
   (the pattern M4/M5 established), `dependencies: { knex, mongodb }`, optional peers for the three drivers
   plus `@playwright/test`, `prepack` running the shared clean. `tsconfig.json` mirrors Appium's minus the
   `platform`/`mobile-core` references — this plugin needs neither. Add it to the root tsconfig.
2. **`src/core/sqlConnection.ts`** — `createSqlConnection(options)` builds the Knex instance and pings with
   `SELECT 1`, returning the instance or a reason; `closeSqlConnection(knex)`.
3. **`src/core/mongoConnection.ts`** — the same shape over `MongoClient` and `db.command({ ping: 1 })`.
4. **`src/core/resetSql.ts` + `src/core/resetMongo.ts`** — decision 5.
5. **`src/core/mongoMigrate.ts`** — `runMongoMigrations(db, dir)` and `rollbackMongoMigration(db, dir)`, with
   the tests decision 4 requires.
6. **`src/fixtureSql.ts`** — the worker option, the worker-scoped connection, and the test-scoped `sql` that
   skips (decisions 2 and 3).
7. **`src/fixtureMongo.ts`** — the same shape.
8. **`src/index.ts`** — one `base.extend({ …sqlFixtures, …mongoFixtures })`, because unlike the two mobile
   plugins these families ship in the same package and so need no `mergeTests`. Exports `test`, `expect`, the
   two reset helpers and the two Mongo migration functions.
9. **`src/ensure.ts`** — advisory only: check that the driver named by `DB_CLIENT` resolves, and hint when a
   `MONGO_CONNECTION_STRING` is set but unusable. `knex`/`mongodb` are always present, being dependencies.
10. **`src/manifest.ts`** — `id: 'db'`, no `playwrightProject`, env keys (`DB_CLIENT`, `DB_CONNECTION_STRING`,
    `MONGO_CONNECTION_STRING`, `MONGO_DATABASE`), `fixture.test.alias: 'dbTest'`, the migrate/seed scripts,
    examples and docs, `ensure`.
11. **`templates/`** — `db/knexfile.ts`, one example migration per engine, a seed, and
    `tests/db/example.db.ts` showing both fixtures plus a reset.
12. **Docs** — README + `docs/DB_TESTING.md`: both families, the migration/seed/reset flow, why two fixtures,
    the worker-option consequences from decision 2, the `better-sqlite3` caveat, and that this plugin does not
    install a database any more than the mobile plugins install a device (with a `docker compose` example as a
    convenience, not a requirement).
13. **`packages/create/src/registry.ts`** — a `data` category entry for `@pwtap/plugin-db`.
14. **`.commitlintrc.json`** — add `db` to the scope enum, in the same commit, rather than discovering it at
    commit time as happened with `appium`.
15. **`scripts/nfr-check.mjs`** — derive the package list from the workspace instead of the hardcoded
    `['mobile-core', 'plugin-maestro', 'plugin-appium']`, which a new plugin silently escapes.
16. **Changesets** — verify whether a never-published package needs its own changeset to be released, rather
    than assuming; add one for `@pwtap/create` either way.

## Verification

- `tsc -b`, `eslint`, and the unit tests for the Mongo runner.
- The M4/M5 sequence: fresh scaffold → pack → install → `add db --no-install` → assert the barrel merged
  `dbTest`, the env keys landed, the examples copied → `tsc --noEmit` green.
  **What the live run settled, beyond passing:**

- The scaffolded example matched no Playwright project. The core scaffold collects `.spec.ts`/`.test.ts` and the
  `api` project `.api.ts`, so an `example.db.ts` was never run by anything — decision 7 removed the project
  without checking what would then collect the file. It is `example.db.spec.ts` now, which the browser project
  picks up at no cost, since Playwright starts a browser only for a test that asks for `page`.
- **Worker-scoped connections pool connections, not data.** The example passed on one worker and failed on two:
  a blanket reset in one worker empties the table for every other worker, mid-test. Decision 2 accounted for the
  connection and not for the shared state. The example now tags its rows with the worker index and clears only
  those, and `DB_TESTING.md` carries the three ways out with their trade-offs.
- The knexfile ships as `.mjs`, not `.ts`. Knex's CLI hunts for a TypeScript loader when the knexfile itself is
  `.ts`, printing six `Failed to load external module` lines before succeeding anyway on Node ≥ 22.6. The `.ts`
  migrations load either way, so the extension bought only output that reads like failure.
- `resetSqlDatabase` now explains a named table that does not exist ("run your migrations first") instead of
  surfacing a raw driver error behind a pg-protocol stack trace.

- **Live, against real engines.** Docker is available on this machine (29.6.2), so a throwaway Postgres and
  MongoDB come up and the whole loop runs against them: connect, query, migrate, roll back, reset. MySQL,
  MariaDB and SQLite are deliberately out of scope for live runs — Knex uses one code path for every SQL
  dialect, so Postgres proves it; MongoDB is a separate code path and is verified separately.
- **The env keys had to be read by the fixtures, not by the example.** Decision 1 showed configuration as
  `test.use({ db: … })` and left the env plumbing to the template, which read `process.env` in its module scope.
  Module scope is evaluated at a moment that depends on how the run was launched, so a user got
  `no pg connection configured` with the value filled in — and `openSqlConnection`'s own skip message had been
  promising "or the DB_* env keys" all along with nothing behind it. The fixtures resolve the keys now; the option
  is an override that wins over them.
