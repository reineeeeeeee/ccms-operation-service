import { cronRoute } from 'ccms-shared';
import { runComputePending as run } from '../../../../jobs/compute-pending.js';

export const dynamic = 'force-dynamic';

// Vercel Cron calls this (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
// It fills in the compliance result of completed transactions that were completed while Core could not answer.
export const GET = cronRoute('compute-pending', () => run());
