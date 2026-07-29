# @pwtap/plugin-db

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
