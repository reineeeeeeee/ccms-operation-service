import { cronRoute } from 'ccms-shared';
import { runAutoCloseJob } from '../../../../jobs/auto-close.js';

export const dynamic = 'force-dynamic';

// Vercel Cron calls this (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
// It closes open transactions that are past the auto-close limit of their classification: { checked, closed, skipped }.
export const GET = cronRoute('auto-close', () => runAutoCloseJob());
