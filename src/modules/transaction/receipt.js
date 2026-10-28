import { manilaParts, recordAudit } from 'ccms-shared';
import { randomUUID } from 'node:crypto';
import { kickOutbox } from '../../lib/outbox.js';
import { SYSTEM_ACTOR } from './constants.js';
import { rowsOf } from './db.js';

export const RECEIPT_MAX_ATTEMPTS = 5;
export const RECEIPT_BATCH = 50;
export const RECEIPT_CLAIM_MS = 120_000;

const pad = (n) => String(n).padStart(2, '0');

/** 'MM/DD/YYYY h:mm AM' in Asia/Manila (Decision C32). */
export function manilaStamp(value) {
  const p = manilaParts(value);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${pad(p.month)}/${pad(p.day)}/${p.year} ${hour12}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * The receipt email: the tracking number, the service, the office, when it was started and completed, and the line to quote
 * the tracking number when filing a complaint. It never carries the compliance result or the names of staff, and nobody but the
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
      `Office: ${row.office_name ?? 'Office name unavailable (historical record)'}`,
      `Started: ${manilaStamp(row.started_at)}`,
      `Completed: ${manilaStamp(row.ended_at)}`,
      '',
      'Please quote this tracking number whenever you file a complaint about this transaction.',
    ].join('\n'),
  };
}

/**
 * Claims a receipt with a committed expiring token, then pins a row lock during bounded SMTP delivery.
 * Transaction locks work with Neon transaction pooling. SKIP LOCKED prevents another worker reclaiming
 * an active send even after its lease expires. A lost connection aborts SMTP; the lease recovers abandoned work.
 * SMTP acceptance followed by process loss can still cause redelivery: external delivery is not exactly-once.
 */
export async function sendReceipt(dataSource, mailer, row, { leaseMs = RECEIPT_CLAIM_MS } = {}) {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const controller = new AbortController();
  const connection = runner.databaseConnection;
  const lostConnection = () => controller.abort(new Error('Receipt claim connection lost'));
  connection?.on('error', lostConnection);
  connection?.on('end', lostConnection);
  try {
    await runner.startTransaction();
    const [candidate] = await runner.query(`SELECT * FROM transactions WHERE transaction_id = $1
      AND status = 'COMPLETED' AND client_email IS NOT NULL AND
      ((receipt_email_status IN ('PENDING','FAILED') AND receipt_email_attempts < $2)
       OR (receipt_email_status = 'SENDING' AND receipt_email_claim_until <= clock_timestamp()))
      FOR UPDATE SKIP LOCKED`, [row.transaction_id, RECEIPT_MAX_ATTEMPTS]);
    if (!candidate) { await runner.rollbackTransaction(); return 'skipped'; }
    if (candidate.receipt_email_attempts >= RECEIPT_MAX_ATTEMPTS) {
      await runner.query(`UPDATE transactions SET receipt_email_status = 'FAILED', receipt_email_claim_token = NULL,
        receipt_email_claim_until = NULL, version = version + 1 WHERE transaction_id = $1`, [row.transaction_id]);
      await runner.commitTransaction(); return 'skipped';
    }
    const token = randomUUID();
    const claimed = rowsOf(await runner.query(`UPDATE transactions
      SET receipt_email_status = 'SENDING', receipt_email_attempts = receipt_email_attempts + 1,
          receipt_email_claim_token = $2, receipt_email_claim_until = clock_timestamp() + $3 * interval '1 millisecond'
      WHERE transaction_id = $1 AND status = 'COMPLETED' AND client_email IS NOT NULL AND receipt_email_attempts < $4
        AND (receipt_email_status IN ('PENDING','FAILED') OR (receipt_email_status = 'SENDING' AND receipt_email_claim_until <= clock_timestamp()))
      RETURNING *`, [row.transaction_id, token, leaseMs, RECEIPT_MAX_ATTEMPTS]));
    await runner.commitTransaction();
    if (!claimed[0]) return 'skipped';
    await runner.startTransaction();
    const [owned] = await runner.query("SELECT transaction_id FROM transactions WHERE transaction_id=$1 AND receipt_email_status='SENDING' AND receipt_email_claim_token=$2 FOR UPDATE SKIP LOCKED", [row.transaction_id, token]);
    if (!owned) { await runner.rollbackTransaction(); return 'skipped'; }
    let error = null;
    try {
      // SMTP has no idempotency API. A stable Message-ID helps diagnostics, but cannot guarantee exactly-once delivery.
      await mailer.send({ ...buildReceipt(claimed[0]), messageId: `<receipt-${row.transaction_id}@ccms>` }, { signal: controller.signal });
    } catch (err) { error = err; }
    const updated = rowsOf(await runner.query(`UPDATE transactions SET receipt_email_status = $1,
      receipt_email_claim_token = NULL, receipt_email_claim_until = NULL, version = version + 1
      WHERE transaction_id = $2 AND receipt_email_status = 'SENDING' AND receipt_email_claim_token = $3 RETURNING transaction_id`, [error ? 'FAILED' : 'SENT', row.transaction_id, token]));
    if (updated[0]) await recordAudit(runner.manager, {
      ...SYSTEM_ACTOR, action: error ? 'RECEIPT_EMAIL_FAILED' : 'RECEIPT_EMAIL_SENT',
      entityType: 'transaction', entityId: row.transaction_id, officeId: row.office_id,
      entityName: row.tracking_no,
      after: { tracking_no: row.tracking_no },
    });
    await runner.commitTransaction();
    kickOutbox();
    return updated[0] ? (error ? 'failed' : 'sent') : 'skipped';
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => {});
    connection?.removeListener('error', lostConnection);
    connection?.removeListener('end', lostConnection);
    await runner.release();
  }
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
      WHERE status = 'COMPLETED' AND client_email IS NOT NULL AND
        ((receipt_email_status IN ('PENDING', 'FAILED') AND receipt_email_attempts < $1)
         OR (receipt_email_status = 'SENDING' AND receipt_email_claim_until <= clock_timestamp()))
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
