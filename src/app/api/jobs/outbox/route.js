import { cronRoute } from 'ccms-shared';
import { runOutboxDispatch } from '../../../../jobs/outbox-dispatch.js';

export const dynamic = 'force-dynamic';

// Vercel Cron calls this (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
// It sends one batch of audit events from the outbox to the Logs service.
export const GET = cronRoute('outbox', () => runOutboxDispatch());
