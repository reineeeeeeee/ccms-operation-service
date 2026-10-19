import { manilaParts, recordAudit } from 'ccms-shared';
import { kickOutbox } from '../../lib/outbox.js';
import { SYSTEM_ACTOR } from './constants.js';
import { rowsOf } from './db.js';

export const RECEIPT_MAX_ATTEMPTS = 5;
export const RECEIPT_BATCH = 50;

const pad = (n) => String(n).padStart(2, '0');

/** 'MM/DD/YYYY h:mm AM' in Asia/Manila (Decision C32). */
export function manilaStamp(value) {
  const p = manilaParts(value);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${pad(p.month)}/${pad(p.day)}/${p.year} ${hour12}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * The receipt email: the tracking number, the service, the office, when it was started and completed, and the line to quote
 * the tracking number when filing a concern. It never carries the compliance result or the names of staff, and nobody but the
 * citizen's own address receives it. The email carries the details in the body; no attachment (the PDF is made in the browser).
 */
export function buildReceipt(row) {
  return {
    to: row.client_email,
    subject: `Your CCMS transaction receipt ${row.tracking_no}`,
    text: [
      'Your transaction has been recorded.',
      '',
      `Tracking number: ${row.tracking_no}`,
      `Service: ${row.service_name}`,
      `Office: ${row.office_code}`,
      `Started: ${manilaStamp(row.started_at)}`,
      `Completed: ${manilaStamp(row.ended_at)}`,
      '',
      'Please quote this tracking number whenever you file a concern about this transaction.',
    ].join('\n'),
  };
}

/**
 * Sends the receipt email of one completed transaction at most once.
 *   claim   PENDING/FAILED -> the attempt counter goes up by one, only if nobody else tried since we read the row (so two
 *           runs at the same moment never both send);
 *   send    through the mailer;
 *   result  SENT on success (final: SENT is never sent again), FAILED on failure; both are written at once, guarded by
 *           status IN (PENDING, FAILED), and audited RECEIPT_EMAIL_SENT / RECEIPT_EMAIL_FAILED with the tracking number only
 *           (no email address).
 * Returns 'sent', 'failed' or 'skipped' (someone else has it, or it is no longer waiting).
 */
export async function sendReceipt(dataSource, mailer, row) {
  const claimed = rowsOf(
    await dataSource.query(
      `UPDATE transactions SET receipt_email_attempts = receipt_email_attempts + 1
        WHERE transaction_id = $1 AND status = 'COMPLETED' AND client_email IS NOT NULL
          AND receipt_email_status IN ('PENDING', 'FAILED') AND receipt_email_attempts = $2 AND receipt_email_attempts < $3
        RETURNING *`,
      [row.transaction_id, row.receipt_email_attempts, RECEIPT_MAX_ATTEMPTS],
    ),
  );
  if (!claimed[0]) return 'skipped';

  let error = null;
  try {
    await mailer.send(buildReceipt(claimed[0]));
  } catch (err) {
    error = err;
  }
  const status = error ? 'FAILED' : 'SENT';
  await dataSource.transaction(async (manager) => {
    const updated = rowsOf(
      await manager.query(
        `UPDATE transactions SET receipt_email_status = $1, version = version + 1
          WHERE transaction_id = $2 AND receipt_email_status IN ('PENDING', 'FAILED') RETURNING transaction_id`,
        [status, row.transaction_id],
      ),
    );
    if (!updated[0]) return;
    await recordAudit(manager, {
      ...SYSTEM_ACTOR,
      action: error ? 'RECEIPT_EMAIL_FAILED' : 'RECEIPT_EMAIL_SENT',
      entityType: 'transaction',
      entityId: row.transaction_id,
      officeId: row.office_id,
      after: { tracking_no: row.tracking_no },
    });
  });
  kickOutbox();
  return error ? 'failed' : 'sent';
}

/**
 * receipt-emails job: one run tries the completed transactions whose receipt is PENDING or FAILED (fewer than 5 attempts),
 * oldest first, 50 at most. Without SMTP settings nothing is attempted and no attempt is counted.
 * Returns { skipped, checked, sent, failed }.
 */
export async function runReceiptJob({ dataSource, mailer }) {
  if (!mailer.configured) return { skipped: true, reason: 'SMTP_HOST and EMAIL_FROM are required', checked: 0, sent: 0, failed: 0 };
  const rows = await dataSource.query(
    `SELECT * FROM transactions
      WHERE status = 'COMPLETED' AND client_email IS NOT NULL AND receipt_email_status IN ('PENDING', 'FAILED') AND receipt_email_attempts < $1
      ORDER BY ended_at ASC, transaction_id ASC LIMIT ${RECEIPT_BATCH}`,
    [RECEIPT_MAX_ATTEMPTS],
  );
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await sendReceipt(dataSource, mailer, row);
    if (result === 'sent') sent += 1;
    else if (result === 'failed') failed += 1;
  }
  return { skipped: false, checked: rows.length, sent, failed };
}
