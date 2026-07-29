/**
 * Advisory checks after `create-pwtap add db` — hints, never failures.
 *
 * `knex` and `mongodb` are dependencies of this package, so they are always present; there is nothing to check
 * there. What can genuinely be missing is the SQL driver, because the three drivers are OPTIONAL peers so a
 * user installs only the engine they run. Getting that wrong surfaces at the first test as a Knex error about a
 * module, which is a poor place to learn it.
 */
import { createRequire } from 'node:module';

/** The npm package each client needs, in the spelling `DB_CLIENT` uses. */
const DRIVER_FOR_CLIENT: Record<string, string> = {
  pg: 'pg',
  postgres: 'pg',
  postgresql: 'pg',
  mysql: 'mysql2',
  mysql2: 'mysql2',
  mariadb: 'mysql2',
  sqlite3: 'better-sqlite3',
  'better-sqlite3': 'better-sqlite3',
};

export async function ensure(): Promise<void> {
  const warn = (message: string): void => console.warn(`⚠ [db] ${message}`);
  const require = createRequire(`${process.cwd()}/`);

  const client = process.env.DB_CLIENT?.trim().toLowerCase();
  if (client) {
    const driver = DRIVER_FOR_CLIENT[client];
    if (!driver) {
      warn(
        `DB_CLIENT="${client}" is not one of ${[...new Set(Object.keys(DRIVER_FOR_CLIENT))].join(', ')}`,
      );
    } else {
      try {
        require.resolve(driver);
      } catch {
        warn(
          `DB_CLIENT="${client}" needs the ${driver} driver, which is not installed — ` +
            `npm i -D ${driver}${
              driver === 'better-sqlite3' ? ' (a native module: it needs a build toolchain)' : ''
            }`,
        );
      }
    }
  } else if (process.env.DB_CONNECTION_STRING?.trim()) {
    warn(
      'DB_CONNECTION_STRING is set but DB_CLIENT is not — set it to pg, mysql, mariadb or sqlite3',
    );
  }

  // Mongo needs no driver check (mongodb is a dependency here), so the only useful hint is a half-set config.
  if (process.env.MONGO_CONNECTION_STRING?.trim() && !process.env.MONGO_DATABASE?.trim()) {
    warn(
      'MONGO_CONNECTION_STRING is set but MONGO_DATABASE is not — the `mongoDb` option needs both',
    );
  }
}
