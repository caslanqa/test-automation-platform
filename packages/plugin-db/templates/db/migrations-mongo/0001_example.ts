/**
 * An example MongoDB migration — the same `up`/`down` shape as the SQL side, applied in filename order and
 * recorded in `_pwtap_migrations`.
 */
import type { Db } from 'mongodb';

export async function up(db: Db): Promise<void> {
  await db.createCollection('users');
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
}

export async function down(db: Db): Promise<void> {
  await db.collection('users').drop();
}
