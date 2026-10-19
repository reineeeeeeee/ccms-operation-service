import { cronRoute } from 'ccms-shared';
import { runReceiptEmails } from '../../../../jobs/receipt-emails.js';

export const dynamic = 'force-dynamic';

// Vercel Cron calls this (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
// It sends the receipt emails that are PENDING and retries the FAILED ones (fewer than 5 attempts).
export const GET = cronRoute('receipt-emails', () => runReceiptEmails());
