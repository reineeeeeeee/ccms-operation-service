import { recordAudit } from 'ccms-shared';
import { kickOutbox } from '../../lib/outbox.js';
import { STATUS, SYSTEM_ACTOR } from './constants.js';
import { rowsOf } from './db.js';
import { AUTO_CLOSE_BY_CLASSIFICATION, readSettingsRow } from './settings.js';

export const AUTO_CLOSE_BATCH = 100;

/**
 * CC028 auto-close. For the oldest open (IN_PROGRESS or ON_HOLD) transactions - at most 100 per run - whose classification
 * has a threshold set: the limit is the closing time of the Nth working day after the start (Core /deadline, held minutes 0, so
 * time on hold counts toward abandonment). If now is past it the transaction becomes AUTO_CLOSED with a guarded UPDATE
 * (a transaction completed meanwhile is left alone), the hold is cleared and ended_at stays empty (the two-timestamp rule keeps
 * ended_at for real completions). Audited with actor_role "system". A row whose Core call fails is skipped; nothing is closed
 * when Core is down. Thresholds are read on every run, so a change applies to the next run. Safe to run twice.
 * Returns { checked, closed, skipped }.
 */
export async function runAutoClose({ dataSource, core, now = () => new Date() }) {
  const settings = await readSettingsRow(dataSource);
  const thresholds = Object.fromEntries(
    Object.entries(AUTO_CLOSE_BY_CLASSIFICATION)
      .map(([classification, column]) => [classification, settings[column]])
      .filter(([, days]) => Number.isInteger(days)),
  );
  const classifications = Object.keys(thresholds);
  if (classifications.length === 0) return { checked: 0, closed: 0, skipped: 0 };

  const candidates = await dataSource.query(
    `SELECT transaction_id, office_id, started_at, service_classification, status
       FROM transactions
      WHERE status IN ('IN_PROGRESS', 'ON_HOLD') AND service_classification = ANY($1)
      ORDER BY started_at ASC, transaction_id ASC
      LIMIT ${AUTO_CLOSE_BATCH}`,
    [classifications],
  );

  let closed = 0;
  let skipped = 0;
  for (const row of candidates) {
    const days = thresholds[row.service_classification];
    let deadlineMs;
    try {
      deadlineMs = await core.deadline({ start: row.started_at, workingDays: days, officeId: row.office_id, heldMinutes: 0 });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', message: 'Auto-close skipped a transaction: the deadline could not be computed', transaction_id: row.transaction_id, error: err?.message }));
      skipped += 1;
      continue;
    }
    if (now().getTime() <= deadlineMs) continue;
    const didClose = await dataSource.transaction(async (manager) => {
      const rows = rowsOf(
        await manager.query(
          `UPDATE transactions SET status = 'AUTO_CLOSED', hold_started_at = NULL, version = version + 1
            WHERE transaction_id = $1 AND status IN ('IN_PROGRESS', 'ON_HOLD') RETURNING transaction_id`,
          [row.transaction_id],
        ),
      );
      if (!rows[0]) return false;
      await recordAudit(manager, {
        ...SYSTEM_ACTOR,
        action: 'TRANSACTION_AUTO_CLOSED',
        entityType: 'transaction',
        entityId: row.transaction_id,
        officeId: row.office_id,
        before: { status: row.status },
        after: {
          status: STATUS.AUTO_CLOSED,
          service_classification: row.service_classification,
          threshold_working_days: days,
          limit: new Date(deadlineMs).toISOString(),
        },
      });
      return true;
    });
    if (didClose) closed += 1;
  }
  if (closed > 0) kickOutbox();
  return { checked: candidates.length, closed, skipped };
}
