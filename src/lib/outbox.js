import { after } from 'next/server.js';

// There is no background process on Vercel, so "send it right away" means: after the response has
// been sent, run one dispatch. If that does not happen (the function is stopped, the other system is
// down) the cron jobs in src/jobs pick the work up on their next run. Outside a request (tests,
// scripts) after() is not available and the cron route is the only sender - which is fine.
function afterResponse(job) {
  try {
    after(async () => {
      try {
        await job();
      } catch (err) {
        console.error('Dispatch after response failed:', err.message);
      }
    });
  } catch {
    /* not inside a request */
  }
}

export function kickOutbox() {
  afterResponse(async () => (await import('../jobs/outbox-dispatch.js')).runOutboxDispatch());
}

/** Tries the receipt emails that are waiting (CC024) once, after the response. The cron job is the safety net. */
export function kickReceipts() {
  afterResponse(async () => (await import('../jobs/receipt-emails.js')).runReceiptEmails());
}
