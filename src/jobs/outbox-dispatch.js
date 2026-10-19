import { dispatchOutbox } from 'ccms-shared';
import { getDb } from '../lib/data-source.js';

/**
 * Sends one batch of audit events from the outbox to the Logs service. Run by the Vercel Cron route
 * (/api/jobs/outbox) as the safety net, and right after a change commits (see lib/outbox.js).
 */
export async function runOutboxDispatch({ fetchImpl } = {}) {
  const logsUrl = process.env.LOGS_SERVICE_URL;
  const serviceKey = process.env.SERVICE_KEY;
  if (!logsUrl || !serviceKey) {
    return { skipped: true, reason: 'LOGS_SERVICE_URL and SERVICE_KEY are required', sent: 0, failed: 0 };
  }
  return { skipped: false, ...(await dispatchOutbox(await getDb(), { logsUrl, serviceKey, fetchImpl })) };
}
