import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { before, after, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { setupTestEnv, insertTransaction, resetData } from './helpers.js';
import { runReceiptJob, sendReceipt } from '../src/modules/transaction/receipt.js';
import { rowsOf } from '../src/modules/transaction/db.js';
let env;
before(async () => { env = await setupTestEnv(); });
after(async () => { await env?.teardown(); });
beforeEach(async () => { await resetData(env.ds); });
const waiting = (over = {}) => insertTransaction(env.ds, { status: 'COMPLETED', ended_at: new Date(), client_email: 'made-up@example.test', receipt_email_status: 'PENDING', ...over });
const state = async (id) => (await env.ds.query('SELECT * FROM transactions WHERE transaction_id=$1', [id]))[0];
const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
describe('F1 PostgreSQL exclusive receipt claims', () => {
  it('prevents staggered full jobs from sending a freshly reread row during SMTP', async () => {
    const row = await waiting(); const entered = gate(); const unblock = gate(); let sends = 0;
    const mailer = { configured: true, async send() { sends++; entered.release(); await unblock.promise; } };
    const first = runReceiptJob({ dataSource: env.ds, mailer });
    await entered.promise;
    assert.equal((await state(row.transaction_id)).receipt_email_status, 'SENDING');
    const second = await runReceiptJob({ dataSource: env.ds, mailer });
    assert.equal(second.sent, 0);
    assert.equal(sends, 1);
    unblock.release(); await first;
    assert.equal((await state(row.transaction_id)).receipt_email_status, 'SENT');
    assert.equal((await state(row.transaction_id)).receipt_email_claim_token, null);
  });
  it('holds exclusive ownership even if the active send runs beyond its lease', async () => {
    const row = await waiting(); const entered = gate(); const unblock = gate(); let sends = 0;
    const mailer = { configured: true, async send() { sends++; entered.release(); await unblock.promise; } };
    const first = sendReceipt(env.ds, mailer, row, { leaseMs: 1 });
    await entered.promise;
    await env.ds.query('SELECT pg_sleep(0.02)');
    assert.equal(await sendReceipt(env.ds, mailer, await state(row.transaction_id)), 'skipped');
    assert.equal(sends, 1); unblock.release(); await first;
  });
  it('recovers an expired claim left by a dead worker with a new ownership token', async () => {
    const oldToken = randomUUID();
    const row = await waiting({ receipt_email_status: 'SENDING', receipt_email_attempts: 1, receipt_email_claim_token: oldToken, receipt_email_claim_until: new Date(Date.now() - 1000) });
    let sends = 0;
    const result = await runReceiptJob({ dataSource: env.ds, mailer: { configured: true, async send() { sends++; const current = await state(row.transaction_id); assert.notEqual(current.receipt_email_claim_token, oldToken); } } });
    assert.equal(result.sent, 1); assert.equal(sends, 1);
    assert.equal((await state(row.transaction_id)).receipt_email_attempts, 2);
  });
  it('fences an old result from overwriting another claim and clears exhausted abandoned claims', async () => {
    const oldToken = randomUUID();
    const row = await waiting({ receipt_email_status: 'SENDING', receipt_email_claim_token: randomUUID(), receipt_email_claim_until: new Date(Date.now() - 1000) });
    const stale = await env.ds.query("UPDATE transactions SET receipt_email_status='SENT', receipt_email_claim_token=NULL, receipt_email_claim_until=NULL WHERE transaction_id=$1 AND receipt_email_claim_token=$2 RETURNING transaction_id", [row.transaction_id, oldToken]);
    assert.equal(rowsOf(stale).length, 0);
    await env.ds.query("UPDATE transactions SET receipt_email_attempts=5, receipt_email_claim_until=now()-interval '1 second' WHERE transaction_id=$1", [row.transaction_id]);
    await runReceiptJob({ dataSource: env.ds, mailer: { configured: true, async send() { assert.fail('retry budget exhausted'); } } });
    assert.equal((await state(row.transaction_id)).receipt_email_status, 'FAILED');
  });
  it('keeps the existing failure retry policy', async () => {
    const row = await waiting(); let attempts = 0;
    const mailer = { configured: true, async send() { if (++attempts === 1) throw new Error('temporary SMTP failure'); } };
    assert.equal((await runReceiptJob({ dataSource: env.ds, mailer })).failed, 1);
    assert.equal((await state(row.transaction_id)).receipt_email_status, 'FAILED');
    assert.equal((await runReceiptJob({ dataSource: env.ds, mailer })).sent, 1);
    assert.equal((await runReceiptJob({ dataSource: env.ds, mailer })).checked, 0);
  });
  it('recovers after an actual PostgreSQL worker connection is terminated', async () => {
    const row = await waiting({ receipt_email_status: 'SENDING', receipt_email_attempts: 1, receipt_email_claim_token: randomUUID(), receipt_email_claim_until: new Date(Date.now() - 1000) });
    const crashed = new pg.Client({ connectionString: env.ds.options.url });
    crashed.on('error', () => {});
    await crashed.connect();
    try {
      await crashed.query('BEGIN');
      await crashed.query('SELECT transaction_id FROM transactions WHERE transaction_id=$1 FOR UPDATE', [row.transaction_id]);
      const { rows: [{ pid }] } = await crashed.query('SELECT pg_backend_pid() AS pid');
      const mailer = { configured: true, async send() {} };
      assert.equal((await runReceiptJob({ dataSource: env.ds, mailer })).sent, 0);
      await env.ds.query('SELECT pg_terminate_backend($1)', [pid]);
      await crashed.end();
      assert.equal((await runReceiptJob({ dataSource: env.ds, mailer })).sent, 1);
    } finally { await crashed.end().catch(() => {}); }
  });
});
