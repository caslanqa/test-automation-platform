# @pwtap/plugin-db

## 1.1.2

### Patch Changes

- 7b24ed4: Correct the CLI invocation in the README — `npx create-pwtap` is not a package

  There is no `create-pwtap` package on the npm registry, and a scaffolded project does not get that bin
  either, so `npx create-pwtap add db` fails with a 404 for anyone who has not globally installed
  `@pwtap/create`. The documented invocation is `npx @pwtap/create add db`.

  These two packages have no other change in this release, and the patch exists so the corrected README
  actually reaches npmjs.com — a fix that only lands in the repository leaves the page every user reads
  still telling them to run a command that does not resolve.

## 1.1.1

### Patch Changes

- 798c95e: Say why a test was skipped in the terminal, not only in the report

  A skipped test showed a dash and its name — no reason — so an unreachable database or an absent device looked
  like an unexplained gap in the run. The reason was never missing: `testInfo.skip(condition, description)` records
  it as a `skip` annotation, which the HTML and JSON reports read and **no terminal reporter prints**. The reason is
  now printed beside the skip as well, and still recorded for the report.

  Two things the live run through the packed tarballs then exposed, both about the reason itself rather than where
  it goes: an uninstalled driver was reported as Knex's `Cannot find module 'pg'` plus a six-line require stack,
  naming no fix, and is now `the pg driver is not installed — run \`npm i -D pg\``; and the console line is held to
  one line whatever a driver decides to say, with the whole text still in the report.

  Running the installed example against a real project then found three more, all in the same family — an option
  that is EMPTY rather than absent, which is exactly what `create` writes into `env/environments.json` for a user to
  fill in:

  - The scaffolded example used `process.env.DB_CLIENT ?? 'pg'`. `??` falls back only on null/undefined, so the
    default never fired in the one case it existed for: an empty key reached Knex as a missing one and the reason
    read `could not create a  connection` — a sentence with a hole in it. Every template now uses `||`.
  - `createSqlConnection` validates its own options instead of relaying Knex's `Required configuration option
'client' is missing`: an empty client, an unknown one (`postgresql` is the likely spelling) and an empty
    connection each name the thing to set.
  - **An unconfigured MongoDB failed the test instead of skipping it.** `new MongoClient('')` throws a
    MongoParseError and was constructed outside the try, bypassing the return-a-reason contract entirely. Measured
    as `1 failed` on a scaffolded project. Both keys are now checked, and the constructor moved inside the try so a
    malformed URI is a reason like any other.

  Finally, the fixtures read the DB_* and MONGO_* env keys themselves, which is what `openSqlConnection` had been
  claiming in its own skip message all along without any code behind it. The scaffolded example did the reading, in
  its module scope, and a user hit the consequence: `no pg connection configured` while the connection string sat
  filled in inside `env/environments.json`. A module's top level is evaluated at a moment that depends on how the
  run was launched, so the read could happen before the config's `loadEnv()` reached it; a fixture body cannot. The
  example sets no option now, and an option that is set wins, with anything it omits falling back to the env.

  The README and `docs/DB_TESTING.md` are rewritten around what a reader actually does, in order: install the driver
  for your engine, configure the env keys, write the check inside the test that caused it, run it, keep tests
  independent under parallelism, migrate and seed, then read the results — including what each of the four scaffolded
  reporters records for a skip, and a table of every measured skip message with the fix. Both had also gone stale:
  each still showed the `test.use({ db: { client, connection } })` pattern this release removes.

## 1.1.0

### Minor Changes

- 6c75130: New plugin: `@pwtap/plugin-db` — database testing across PostgreSQL, MySQL, MariaDB and SQLite (through Knex)
  plus MongoDB, covering query assertions, seed/reset and migration verification.

  Two independent fixture families rather than one universal API, because relational and document models differ
  at the root and a layer over both would leak where you need precision: `db` → `sql` hands over a raw Knex
  instance, `mongoDb` → `mongo` a raw MongoDB `Db`. Four distinct names, so the barrel merges them alongside
  every other plugin.

  Connections are worker-scoped, so one pool serves a worker and Playwright closes it — no teardown project,
  unlike the mobile plugins. A database that is unreachable or unconfigured **skips** the test with the reason
  rather than failing it. SQL migrations are Knex's own system wired up; MongoDB has no equivalent, so the plugin
  ships a small runner (files with `up(db)`/`down(db)`, applied in filename order, tracked in
  `_pwtap_migrations`) instead of taking a third dependency.

  `@pwtap/create` gains the registry entry, which is the part that actually makes `create-pwtap add db` offer it.

  Every SQL dialect is verified against a real engine, not just Postgres: `resetSqlDatabase` emits different SQL
  for each and `discoverTables` reads a different catalog, so "Knex uses one code path" was true of the query
  builder and false of the part this plugin wrote. All four pass, and each skips when its engine is absent.
