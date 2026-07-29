/**
 * `@pwtap/create` injection manifest for the database plugin.
 *
 * Shaped like `ai-judge`, not like the mobile plugins: **no env-gated Playwright project.** These fixtures are
 * used *inside* API and UI tests — "did the row appear?" — so a separate `db` project would get between the
 * test and the thing it is checking. They merge into `@fixtures` and are available in every file; standalone
 * DB-only files work from the same barrel, and need no gate because an unreachable database already skips.
 *
 * @example
 * // env/environments.json → common: { "DB_CLIENT": "pg", "DB_CONNECTION_STRING": "postgres://…" }
 * test.use({ db: { client: 'pg', connection: process.env.DB_CONNECTION_STRING! } });
 */
export const manifest = {
  id: 'db',
  name: '@pwtap/plugin-db',
  devDependencies: {},
  scripts: {
    // Knex's own CLI, pointed at the scaffolded knexfile — the SQL side is wiring, not new code.
    'db:migrate:latest': 'knex --knexfile db/knexfile.mjs migrate:latest',
    'db:migrate:rollback': 'knex --knexfile db/knexfile.mjs migrate:rollback',
    'db:migrate:make': 'knex --knexfile db/knexfile.mjs migrate:make',
    'db:seed': 'knex --knexfile db/knexfile.mjs seed:run',
    // MongoDB has no CLI of its own, so these run the small runner this package ships.
    'db:mongo:migrate': 'node --experimental-strip-types db/mongo-migrate.ts up',
    'db:mongo:migrate:rollback': 'node --experimental-strip-types db/mongo-migrate.ts down',
  },
  envKeys: {
    DB_CLIENT: '',
    DB_CONNECTION_STRING: '',
    MONGO_CONNECTION_STRING: '',
    MONGO_DATABASE: '',
  },
  fixture: {
    importFrom: '@pwtap/plugin-db',
    test: { export: 'test', alias: 'dbTest' },
  },
  examples: [
    { src: 'templates/tests', dest: 'tests/db' },
    { src: 'templates/db', dest: 'db' },
  ],
  docs: [{ src: 'docs/DB_TESTING.md', dest: 'docs/DB_TESTING.md' }],
  ensure: 'ensure',
  readmeSection: [
    '## Database',
    '',
    'Two independent fixture families, both raw clients rather than a wrapper:',
    '',
    '- `sql` — a Knex instance for PostgreSQL, MySQL, MariaDB or SQLite. Set `DB_CLIENT` and',
    '  `DB_CONNECTION_STRING` in `env/environments.json`.',
    '- `mongo` — a MongoDB `Db`. Set `MONGO_CONNECTION_STRING` and `MONGO_DATABASE`.',
    '',
    'The fixtures read those keys themselves, so no `test.use({ db })` is needed. Set the option to override one',
    'file — `test.use({ db: { client: "better-sqlite3", connection: { filename: ":memory:" } } })` — and it wins,',
    'with anything it leaves out still coming from the env.',
    '',
    'Both connections are **worker-scoped**, so one pool serves a worker and Playwright closes it. That means',
    'the option must be set at the top level of a file, never inside `describe` — Playwright refuses it there,',
    'since a different value forces a new worker.',
    '',
    'An unreachable or unconfigured database **skips** the test rather than failing it, the same way an absent',
    'device does, and prints why. Reset with `resetSqlDatabase(sql)` / `resetMongoDatabase(mongo)`; migrate SQL with the',
    '`db:migrate:*` scripts (Knex’s own system) and Mongo with `db:mongo:migrate*`.',
    '',
    'See `docs/DB_TESTING.md`. This plugin does not install a database, just as the mobile plugins do not',
    'install a device.',
  ].join('\n'),
} as const;
