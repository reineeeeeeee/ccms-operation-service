import { getMailer } from '../lib/mailer.js';
import { getDb } from '../lib/data-source.js';
import { runReceiptJob } from '../modules/transaction/receipt.js';

/** One run of receipt-emails (CC024): sends or retries the waiting receipts. */
export async function runReceiptEmails(overrides = {}) {
  return runReceiptJob({ dataSource: await getDb(), mailer: getMailer(), ...overrides });
}
