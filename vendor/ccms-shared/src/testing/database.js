import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDataSource } from '../db.js';

// Tests run against a real PostgreSQL server (TypeORM + Postgres features such as triggers).
// Point TEST_PG_URL at any server where the user may CREATE DATABASE.
export const DEFAULT_TEST_PG_URL = 'postgres://postgres:postgres@127.0.0.1:55432/postgres';

/**
 * Creates a fresh, uniquely named database, initialises a DataSource on it (tables are created
 * from the entities) and returns { dataSource, url, drop }. Call drop() in an `after` hook.
 */
export async function createTestDatabase({ entities, afterSync } = {}) {
  const adminUrl = process.env.TEST_PG_URL ?? DEFAULT_TEST_PG_URL;
  const name = `ccms_test_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const dataSource = createDataSource({ url: url.toString(), entities, synchronize: true });
  await dataSource.initialize();
  if (afterSync) await afterSync(dataSource);

  return {
    dataSource,
    url: url.toString(),
    async drop() {
      if (dataSource.isInitialized) await dataSource.destroy();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
