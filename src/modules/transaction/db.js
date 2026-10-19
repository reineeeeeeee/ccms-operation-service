import { Errors, isUniqueViolation } from 'ccms-shared';

/** TypeORM answers UPDATE/DELETE ... RETURNING with [rows, count]; this returns just the rows either way. */
export function rowsOf(result) {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

export const TRANSACTION_SELECT = `
  SELECT t.*, c.label AS counter_label
    FROM transactions t
    LEFT JOIN counters c ON c.counter_id = t.counter_id`;

/** One transaction row (with its counter label), or null. `manager` is a data source or a transaction manager. */
export async function loadTransactionRow(manager, id) {
  const rows = await manager.query(`${TRANSACTION_SELECT} WHERE t.transaction_id = $1`, [id]);
  return rows[0] ?? null;
}

export function notFound() {
  return Errors.notFound('Transaction not found', 'TRANSACTION_NOT_FOUND');
}

export { isUniqueViolation };
