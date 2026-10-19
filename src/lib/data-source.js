import { getDataSource } from 'ccms-shared';
import { afterSync } from './after-sync.js';
import { entities } from './entities/index.js';

export const dbOptions = { entities, afterSync };

/** The service's initialised TypeORM DataSource (created on first use, shared per process). */
export function getDb() {
  return getDataSource(dbOptions);
}
