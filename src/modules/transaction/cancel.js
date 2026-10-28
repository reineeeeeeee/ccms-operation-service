import { Errors, recordAudit } from 'ccms-shared';
import { kickOutbox } from '../../lib/outbox.js';
import { MSG, REASON_MAX, STATUS } from './constants.js';
import { loadTransactionRow, notFound, rowsOf } from './db.js';
import { toTransactionDto } from './dto.js';
import { assertCanCancel } from './access.js';

/**
 * CC025 Cancel an open transaction with a reason. Office Head (own office) and Super Admin only; Office Staff and Executive
 * get 403 (before anything else is said about the transaction). The update is guarded by the status, so whichever of
 * "cancel" and "complete" commits first wins and the other gets 409. The end time stays empty, the hold is cleared and
 * no held minutes are added.
 */
export async function cancelTransaction(dataSource, user, id, body, { ipAddress } = {}) {
  const row = await loadTransactionRow(dataSource, id);
  if (!row) throw notFound();
  assertCanCancel(user, row);

  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > REASON_MAX) throw Errors.validation(MSG.CANCEL_REASON, { reason: MSG.CANCEL_REASON });

  const cancelled = await dataSource.transaction(async (manager) => {
    const rows = rowsOf(
      await manager.query(
        `UPDATE transactions SET status = 'CANCELLED', cancel_reason = $1, hold_started_at = NULL, version = version + 1
          WHERE transaction_id = $2 AND status IN ('IN_PROGRESS', 'ON_HOLD') RETURNING *`,
        [reason, id],
      ),
    );
    if (!rows[0]) return null;
    await recordAudit(manager, {
      actor: user,
      action: 'TRANSACTION_CANCELLED',
      entityType: 'transaction',
      entityId: id,
      entityName: row.tracking_no,
      officeId: row.office_id,
      before: { status: row.status },
      after: { status: STATUS.CANCELLED, reason },
      ipAddress,
    });
    return rows[0];
  });
  if (!cancelled) {
    const current = await loadTransactionRow(dataSource, id);
    throw Errors.conflict(MSG.CANCEL_STATE, 'INVALID_STATE', { status: current?.status ?? row.status });
  }
  kickOutbox();
  return toTransactionDto(await loadTransactionRow(dataSource, id));
}
