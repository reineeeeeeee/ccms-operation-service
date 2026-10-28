import { createDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { migrateSprint4Operations } from '../src/lib/migrations/sprint4-critical.js';
const ds = createDataSource({ ...dbOptions, synchronize: false });
await ds.initialize();
try { await migrateSprint4Operations(ds); console.log('Sprint 4 Operations migration completed'); }
finally { await ds.destroy(); }
