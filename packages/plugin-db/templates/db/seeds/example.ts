/** An example Knex seed, run by `npm run db:seed`. MongoDB has no seed framework — write a plain script. */
import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  await knex('users').del();
  await knex('users').insert([{ email: 'demo@example.com' }]);
}
