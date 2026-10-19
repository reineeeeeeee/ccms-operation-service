import { Errors } from 'ccms-shared';
import { computeAndStoreResult } from './complete.js';

export const COMPUTE_BATCH = 50;

/**
 * compute-pending (CC023): picks COMPLETED rows whose result is still empty - 50 per run, oldest first - and runs the
 * compute and write steps for each, with actor_role "system". A row whose Core call fails is skipped (tried again next run).
 * Returns { checked, computed, skipped }.
 */
export async function runComputePending({ dataSource, core }) {
  if (!core) throw Errors.unavailable('Core is not configured', 'CORE_NOT_CONFIGURED');
  const rows = await dataSource.query(
    `SELECT * FROM transactions
      WHERE status = 'COMPLETED' AND elapsed_working_minutes IS NULL
      ORDER BY ended_at ASC, transaction_id ASC
      LIMIT ${COMPUTE_BATCH}`,
  );
  let computed = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await computeAndStoreResult(dataSource, core, row, { system: true });
    if (result.computed) computed += 1;
    else skipped += 1;
  }
  return { checked: rows.length, computed, skipped };
}
