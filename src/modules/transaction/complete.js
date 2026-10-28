import { Errors, recordAudit } from 'ccms-shared';
import { kickOutbox, kickReceipts } from '../../lib/outbox.js';
import { MSG, STATUS, SYSTEM_ACTOR } from './constants.js';
import { loadTransactionRow, notFound, rowsOf } from './db.js';
import { toTransactionDto } from './dto.js';
import { assertCanAccess } from './access.js';
import { computeCompliance } from './compliance.js';
import { parseBackdate } from './time.js';

const statusWord = (status) => status.toLowerCase().replace('_', '-');

/**
 * Step 2 and 3 of CC023: ask Core, then write the result once.
 * Step 2 happens between the two short database transactions, so a slow Core never holds a lock. If Core cannot answer
 * (after its one retry) nothing is written and the result stays empty ("Pending computation"); the compute-pending job tries again.
 * Step 3 only writes WHERE elapsed_working_minutes IS NULL, so the job and a request never write twice.
 * `actor` is the user; for the job pass { system: true } and the entry is recorded with actor_role "system".
 * Returns { computed: true } when this call wrote the result.
 */
export async function computeAndStoreResult(dataSource, core, row, { actor, system = false, ipAddress } = {}) {
  let result;
  try {
    result = await computeCompliance(core, {
      startedAt: row.started_at,
      endedAt: row.ended_at,
      heldMinutes: row.held_minutes,
      officeId: row.office_id,
      days: row.standard_duration_days,
      hours: row.standard_duration_hours,
      minutes: row.standard_duration_minutes,
    });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Compliance could not be computed yet', transaction_id: row.transaction_id, error: err?.message }));
    return { computed: false };
  }

  const written = await dataSource.transaction(async (manager) => {
    const rows = rowsOf(
      await manager.query(
        `UPDATE transactions SET elapsed_working_minutes = $1, is_compliant = $2, variance_minutes = $3, version = version + 1
          WHERE transaction_id = $4 AND status = 'COMPLETED' AND elapsed_working_minutes IS NULL RETURNING transaction_id`,
        [result.elapsed, result.isCompliant, result.variance, row.transaction_id],
      ),
    );
    if (!rows[0]) return false;
    await recordAudit(manager, {
      ...(system ? SYSTEM_ACTOR : { actor }),
      action: 'TRANSACTION_RESULT_COMPUTED',
      entityType: 'transaction',
      entityId: row.transaction_id,
      entityName: row.tracking_no,
      officeId: row.office_id,
      after: { elapsed_working_minutes: result.elapsed, is_compliant: result.isCompliant, variance_minutes: result.variance },
      ipAddress,
    });
    return true;
  });
  if (written) kickOutbox();
  return { computed: written };
}

/**
 * CC023 Complete a transaction.
 *   Step 1 (database transaction 1): IN_PROGRESS -> COMPLETED with ended_at = the click (server time), guarded by the status,
 *          so a second click, or a cancel at the same moment, gets 409 with the current status. Audited TRANSACTION_COMPLETED.
 *   Step 2/3: computeAndStoreResult. The end time is saved even if Core is down; the answer then has a null result.
 * CC026: { ended_at, backdate_reason } records an end time entered by the user (after the fact), which flags the entry.
 * CC024: a transaction with a client email is marked receipt PENDING in step 1 and the email is tried after the response.
 */
export async function completeTransaction(dataSource, { core, now = () => new Date() }, user, id, body, { ipAddress } = {}) {
  const existing = await loadTransactionRow(dataSource, id);
  if (!existing) throw notFound();
  assertCanAccess(user, existing);

  const requestTime = now();
  const backdate = parseBackdate(body ?? {}, { now: requestTime, storedStart: existing.started_at, allowStart: false });
  const endedAt = backdate.endedAt ?? requestTime;
  const backdated = backdate.endedAt !== null;

  const completed = await dataSource.transaction(async (manager) => {
    const rows = rowsOf(
      await manager.query(
        `UPDATE transactions
            SET status = 'COMPLETED', ended_at = $1, ended_by = $2, version = version + 1,
                is_backdated = is_backdated OR $3::boolean,
                backdate_reason = CASE WHEN $3::boolean THEN COALESCE(backdate_reason || E'\\n', '') || $4::text ELSE backdate_reason END,
                receipt_email_status = CASE WHEN client_email IS NOT NULL THEN 'PENDING' ELSE receipt_email_status END
          WHERE transaction_id = $5 AND status = 'IN_PROGRESS' AND started_at < $1
          RETURNING *`,
        [endedAt, user.id, backdated, backdate.backdateReason, id],
      ),
    );
    if (!rows[0]) return null;
    await recordAudit(manager, {
      actor: user,
      action: 'TRANSACTION_COMPLETED',
      entityType: 'transaction',
      entityId: id,
      entityName: rows[0].tracking_no,
      officeId: rows[0].office_id,
      before: { status: STATUS.IN_PROGRESS },
      after: { status: STATUS.COMPLETED, ended_at: endedAt.toISOString() },
      ipAddress,
    });
    if (backdated) {
      await recordAudit(manager, {
        actor: user,
        action: 'TRANSACTION_BACKDATED',
        entityType: 'transaction',
        entityId: id,
        entityName: rows[0].tracking_no,
        officeId: rows[0].office_id,
        after: { field: 'ended_at', value: endedAt.toISOString(), reason: backdate.backdateReason },
        ipAddress,
      });
    }
    return rows[0];
  });

  if (!completed) {
    const current = await loadTransactionRow(dataSource, id);
    if (!current) throw notFound();
    if (current.status === STATUS.IN_PROGRESS) {
      // Still in progress: the only guard left is the time order (a clock that runs behind the start).
      throw Errors.validation(MSG.END_AFTER_START, { ended_at: MSG.END_AFTER_START });
    }
    const message = current.status === STATUS.ON_HOLD ? MSG.RESUME_FIRST : `This transaction is already ${statusWord(current.status)}`;
    throw Errors.conflict(message, 'INVALID_STATE', { status: current.status });
  }
  kickOutbox();

  await computeAndStoreResult(dataSource, core, completed, { actor: user, ipAddress });
  if (completed.client_email) kickReceipts();
  return toTransactionDto(await loadTransactionRow(dataSource, id));
}
