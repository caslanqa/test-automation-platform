/**
 * `npm run db:mongo:migrate` / `db:mongo:migrate:rollback`.
 *
 * MongoDB has no migration CLI, so this is the thin entry point around the runner the plugin ships.
 */
import {
  createMongoConnection,
  rollbackMongoMigration,
  runMongoMigrations,
} from '@pwtap/plugin-db';

const DIR = new URL('./migrations-mongo/', import.meta.url).pathname;

const opened = await createMongoConnection({
  connection: process.env.MONGO_CONNECTION_STRING || '',
  database: process.env.MONGO_DATABASE || '',
});
if ('reason' in opened) {
  console.error(`[db] ${opened.reason}`);
  process.exit(1);
}

if (process.argv[2] === 'down') {
  const undone = await rollbackMongoMigration(opened.mongo, DIR);
  console.info(undone ? `[db] rolled back ${undone}` : '[db] nothing to roll back');
} else {
  const ran = await runMongoMigrations(opened.mongo, DIR);
  console.info(ran.length ? `[db] applied ${ran.join(', ')}` : '[db] already up to date');
}
await opened.client.close();
