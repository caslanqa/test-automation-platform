/**
 * Database checks, in the two shapes they actually take.
 *
 * The option is set at the top level of the file, never inside `describe`: the connection is worker-scoped, so
 * Playwright refuses a `test.use({ db })` in a group — a different value there would force a new worker.
 *
 * With no database reachable (or none configured), every test here SKIPS rather than fails.
 *
 * Note what this example does NOT do: empty the whole table between tests. Workers share the database, so a
 * blanket reset in one wipes another worker's rows mid-test. Each test here owns rows tagged with its worker
 * index and clears only those — the pattern that stays correct at any level of parallelism. Use
 * `resetSqlDatabase(sql)` when a suite runs serially, or give each worker its own schema or database.
 *
 * Named `.spec.ts` because the core scaffold collects `.spec.ts` and `.test.ts` files, and this plugin adds no
 * project of its own (that is the point — DB checks belong inside the API and UI tests you already have). A
 * DB-only spec costs nothing in the browser project: Playwright starts a browser only for a test that asks for
 * `page`.
 */
// `test`/`expect` come from the barrel, which merges every installed plugin's fixtures. The helpers come from
// the package: the barrel merges test objects and matchers, not arbitrary exports.
import { expect, test } from '@fixtures';

// `||`, not `??`: these keys are written into env/environments.json as EMPTY STRINGS for you to fill in, and
// `??` falls back only on null/undefined — so `?? 'pg'` never fired in the one case it existed for, and an empty
// client reached Knex as a missing one. An unfilled key means "not configured", which skips with a reason.
test.use({
  db: {
    client: (process.env.DB_CLIENT || 'pg') as 'pg',
    connection: process.env.DB_CONNECTION_STRING || '',
  },
  mongoDb: {
    connection: process.env.MONGO_CONNECTION_STRING || '',
    database: process.env.MONGO_DATABASE || '',
  },
});

test.beforeAll(async ({ sql }) => {
  // A real suite migrates instead (`npm run db:migrate:latest`, which applies db/migrations). Created here so
  // this example runs the moment it is scaffolded, with no migration applied yet.
  if (!(await sql.schema.hasTable('users'))) {
    await sql.schema.createTable('users', table => {
      table.increments('id');
      table.string('email').notNullable().unique();
    });
  }
});

/** An address only this worker uses, so parallel workers cannot clear each other's rows. */
const emailFor = (workerIndex: number): string => `demo-w${workerIndex}@example.com`;

test.beforeEach(async ({ sql }, testInfo) => {
  await sql('users')
    .where({ email: emailFor(testInfo.workerIndex) })
    .del();
});

test('the row an action creates is really there', async ({ sql }, testInfo) => {
  const email = emailFor(testInfo.workerIndex);
  // Stands in for the action under test — a request, a UI flow, whatever created the row.
  await sql('users').insert({ email });

  const user = await sql('users').where({ email }).first();
  expect(user).toBeTruthy();
  expect(user.email).toBe(email);
});

test('a document is written as expected', async ({ mongo }, testInfo) => {
  const email = emailFor(testInfo.workerIndex);
  await mongo.collection('users').deleteMany({ email });
  await mongo.collection('users').insertOne({ email });

  const user = await mongo.collection('users').findOne({ email });
  expect(user?.email).toBe(email);
});
