import { Errors, recordAudit } from 'ccms-shared';
import { kickOutbox } from '../../lib/outbox.js';
import { CoreRejectedError, CoreUnavailableError } from './core-client.js';
import { MSG, REASON_MAX, STATUS } from './constants.js';
import { loadTransactionRow, notFound, rowsOf } from './db.js';
import { toTransactionDto } from './dto.js';
import { assertCanAccess } from './access.js';
import { readSettingsRow } from './settings.js';

const VERSION_CONFLICT = 'This transaction was changed by someone else. Reload and try again.';

/** After a guarded UPDATE changed nothing: say why (the status moved on, or the row changed in between). */
async function explainNoChange(dataSource, id, expectedStatus, stateMessage) {
  const current = await loadTransactionRow(dataSource, id);
  if (!current) return notFound();
  if (current.status !== expectedStatus) return Errors.conflict(stateMessage, 'INVALID_STATE', { status: current.status });
  return Errors.conflict(VERSION_CONFLICT, 'VERSION_CONFLICT');
}

/**
 * CC022 Hold. Needs the hold setting on (409 HOLD_DISABLED), a reason of 1-500 characters and status IN_PROGRESS.
 * The update is guarded by the status and the version that was read, so two actions at the same moment cannot both win.
 */
export async function holdTransaction(dataSource, user, id, body, { now = () => new Date(), ipAddress } = {}) {
  const row = await loadTransactionRow(dataSource, id);
  if (!row) throw notFound();
  assertCanAccess(user, row);

  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > REASON_MAX) throw Errors.validation(MSG.HOLD_REASON, { reason: MSG.HOLD_REASON });
  if (!(await readSettingsRow(dataSource)).hold_enabled) throw Errors.conflict(MSG.HOLD_OFF, 'HOLD_DISABLED');
  if (row.status !== STATUS.IN_PROGRESS) throw Errors.conflict(MSG.NOT_IN_PROGRESS, 'INVALID_STATE', { status: row.status });

  const held = await dataSource.transaction(async (manager) => {
    const rows = rowsOf(
      await manager.query(
        `UPDATE transactions SET status = 'ON_HOLD', hold_started_at = $1, hold_reason = $2, version = version + 1
          WHERE transaction_id = $3 AND status = 'IN_PROGRESS' AND version = $4 RETURNING *`,
        [now(), reason, id, row.version],
      ),
    );
    if (!rows[0]) return null;
    await recordAudit(manager, {
      actor: user,
      action: 'TRANSACTION_HELD',
      entityType: 'transaction',
      entityId: id,
      entityName: row.tracking_no,
      officeId: row.office_id,
      before: { status: STATUS.IN_PROGRESS },
      after: { status: STATUS.ON_HOLD, hold_reason: reason, hold_started_at: new Date(rows[0].hold_started_at).toISOString() },
      ipAddress,
    });
    return rows[0];
  });
  if (!held) throw await explainNoChange(dataSource, id, STATUS.IN_PROGRESS, MSG.NOT_IN_PROGRESS);
  kickOutbox();
  return toTransactionDto(await loadTransactionRow(dataSource, id));
}

/**
 * CC022 Resume. Asks Core for the working minutes between the start of the hold and now (one retry inside the client),
 * adds them to the held total, clears the hold and returns to IN_PROGRESS. If Core cannot be reached nothing changes and
 * the answer is 503 CALENDAR_UNAVAILABLE (the transaction stays on hold). Resume still works when the hold setting has since
 * been switched off, so no transaction gets stuck.
 */
export async function resumeTransaction(dataSource, { core, now = () => new Date() }, user, id, { ipAddress } = {}) {
  const row = await loadTransactionRow(dataSource, id);
  if (!row) throw notFound();
  assertCanAccess(user, row);
  if (row.status !== STATUS.ON_HOLD) throw Errors.conflict(MSG.NOT_ON_HOLD, 'INVALID_STATE', { status: row.status });

  const end = now();
  const start = new Date(row.hold_started_at);
  let added = 0;
  if (end.getTime() > start.getTime()) {
    try {
      added = await core.workingMinutes({ start, end, officeId: row.office_id });
    } catch (err) {
      if (err instanceof CoreUnavailableError || err instanceof CoreRejectedError) throw Errors.unavailable(MSG.CALENDAR_DOWN, 'CALENDAR_UNAVAILABLE');
      throw err;
    }
  }

  const resumed = await dataSource.transaction(async (manager) => {
    const rows = rowsOf(
      await manager.query(
        `UPDATE transactions SET status = 'IN_PROGRESS', held_minutes = held_minutes + $1, hold_started_at = NULL, version = version + 1
          WHERE transaction_id = $2 AND status = 'ON_HOLD' AND version = $3 RETURNING *`,
        [added, id, row.version],
      ),
    );
    if (!rows[0]) return null;
    await recordAudit(manager, {
      actor: user,
      action: 'TRANSACTION_RESUMED',
      entityType: 'transaction',
      entityId: id,
      entityName: row.tracking_no,
      officeId: row.office_id,
      before: { status: STATUS.ON_HOLD, held_minutes: row.held_minutes },
      after: { status: STATUS.IN_PROGRESS, held_minutes: rows[0].held_minutes, added_minutes: added },
      ipAddress,
    });
    return rows[0];
  });
  if (!resumed) throw await explainNoChange(dataSource, id, STATUS.ON_HOLD, MSG.NOT_ON_HOLD);
  kickOutbox();
  return toTransactionDto(await loadTransactionRow(dataSource, id));
}
