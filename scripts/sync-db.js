// Creates/updates this service's tables from its TypeORM entities without starting the app.
// The app does the same on start, so this is only for setting up a database ahead of time.
import { getDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';

// Always synchronise here: this connection owns the schema.
const dataSource = await getDataSource({ ...dbOptions, synchronize: true });
const tables = await dataSource.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
);
console.log(`Database ready. Tables: ${tables.map((t) => t.table_name).join(', ') || '(none)'}`);
await dataSource.destroy();
