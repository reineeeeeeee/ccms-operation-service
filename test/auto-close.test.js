// CC028: auto-close abandoned transactions (a limit per classification, in working days; empty = off).
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { GET as autoCloseRoute } from '../src/app/api/jobs/auto-close/route.js';
import { runAutoCloseJob } from '../src/jobs/auto-close.js';
import { AUTO_CLOSE_BATCH } from '../src/modules/transaction/auto-close.js';
import { OFFICE_A, at, insertTransaction, resetData, seedCoreServices, setupTestEnv } from './helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  seedCoreServices(env.core);
});
after(async () => env?.teardown());
beforeEach(async () => {
  env.core.reset();
  await resetData(env.ds);
});

const setLimits = (simple, complex, technical) =>
  env.ds.query('UPDATE transaction_settings SET auto_close_days_simple = $1, auto_close_days_complex = $2, auto_close_days_highly_technical = $3', [simple, complex, technical]);
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);
const stateOf = async (id) => (await env.ds.query('SELECT * FROM transactions WHERE transaction_id = $1', [id]))[0];
// Fixture W: started Tue 2026-10-06 10:00; 2 working days later the limit is Thu 2026-10-08 19:00 (Manila).
const started = new Date(at('2026-10-06', '10:00'));
const run = (nowIso) => runAutoCloseJob({ now: () => new Date(nowIso) });

describe('CC028 auto-close', () => {
  it('AC1: a transaction left open past the limit of its classification is auto-closed; ended_at stays empty; audited as system', async () => {
    await setLimits(null, 2, null);
    const t = await insertTransaction(env.ds, { service_classification: 'COMPLEX', started_at: started });
    const result = await run('2026-10-08T19:01:00+08:00');
    assert.deepEqual(result, { checked: 1, closed: 1, skipped: 0 });
    const row = await stateOf(t.transaction_id);
    assert.equal(row.status, 'AUTO_CLOSED');
    assert.equal(row.ended_at, null, 'the two-timestamp rule keeps ended_at for real completions');
    assert.equal(row.elapsed_working_minutes, null);
    const [event] = (await audits('TRANSACTION_AUTO_CLOSED')).map((x) => x.payload);
    assert.equal(event.actor_role, 'system');
    assert.equal(event.actor_user_id, null);
    assert.equal(event.office_id, OFFICE_A);
    assert.equal(event.entity_id, t.transaction_id);
    assert.equal(event.before_value.status, 'IN_PROGRESS');
    assert.equal(event.after_value.status, 'AUTO_CLOSED');
    assert.equal(event.after_value.threshold_working_days, 2);
    assert.equal(event.after_value.limit, '2026-10-08T11:00:00.000Z');
    const asked = env.core.callsTo('POST', '/deadline')[0].body;
    assert.equal(asked.workingDays, 2);
    assert.equal(asked.heldMinutes, 0, 'time on hold counts toward abandonment');
    assert.equal(asked.officeId, OFFICE_A);
  });

  it('not past the limit yet: nothing happens (exactly at the limit is not past it)', async () => {
    await setLimits(null, 2, null);
    const t = await insertTransaction(env.ds, { service_classification: 'COMPLEX', started_at: started });
    assert.deepEqual(await run('2026-10-08T19:00:00+08:00'), { checked: 1, closed: 0, skipped: 0 });
    assert.equal((await stateOf(t.transaction_id)).status, 'IN_PROGRESS');
  });

  it('AC2: the limit is a setting per classification; a classification with an empty limit is never auto-closed', async () => {
    await setLimits(1, null, null);
    const simple = await insertTransaction(env.ds, { service_classification: 'SIMPLE', started_at: started });
    const complex = await insertTransaction(env.ds, { service_classification: 'COMPLEX', started_at: started });
    const technical = await insertTransaction(env.ds, { service_classification: 'HIGHLY_TECHNICAL', started_at: started });
    assert.deepEqual(await run('2026-11-30T09:00:00+08:00'), { checked: 1, closed: 1, skipped: 0 });
    assert.equal((await stateOf(simple.transaction_id)).status, 'AUTO_CLOSED');
    assert.equal((await stateOf(complex.transaction_id)).status, 'IN_PROGRESS');
    assert.equal((await stateOf(technical.transaction_id)).status, 'IN_PROGRESS');
    await setLimits(null, null, null);
    assert.deepEqual(await run('2026-11-30T09:00:00+08:00'), { checked: 0, closed: 0, skipped: 0 });
    assert.equal(env.core.callsTo('POST', '/deadline').length, 1, 'with every limit empty Core is not even asked');
  });

  it('on-hold transactions are closed too, and the hold is cleared', async () => {
    await setLimits(1, 1, 1);
    const t = await insertTransaction(env.ds, { status: 'ON_HOLD', hold_started_at: started, hold_reason: 'Waiting', held_minutes: 30, started_at: started });
    assert.equal((await run('2026-10-30T09:00:00+08:00')).closed, 1);
    const row = await stateOf(t.transaction_id);
    assert.equal(row.status, 'AUTO_CLOSED');
    assert.equal(row.hold_started_at, null);
    assert.equal(row.held_minutes, 30);
  });

  it('AC3/AC4: AUTO_CLOSED is kept as its own status; running the job twice closes nothing twice and writes one audit entry each', async () => {
    await setLimits(1, 1, 1);
    await insertTransaction(env.ds, { started_at: started });
    await insertTransaction(env.ds, { started_at: started });
    assert.equal((await run('2026-10-30T09:00:00+08:00')).closed, 2);
    assert.deepEqual(await run('2026-10-30T09:00:00+08:00'), { checked: 0, closed: 0, skipped: 0 });
    assert.equal((await audits('TRANSACTION_AUTO_CLOSED')).length, 2);
    assert.equal((await env.ds.query(`SELECT count(*)::int AS n FROM transactions WHERE status = 'AUTO_CLOSED'`))[0].n, 2);
  });

  it('AC5: if Core is unreachable, nothing is closed in that run (every row is skipped)', async () => {
    await setLimits(1, 1, 1);
    await insertTransaction(env.ds, { started_at: started });
    await insertTransaction(env.ds, { started_at: started });
    env.core.setMode('down');
    assert.deepEqual(await run('2026-10-30T09:00:00+08:00'), { checked: 2, closed: 0, skipped: 2 });
    assert.equal((await env.ds.query(`SELECT count(*)::int AS n FROM transactions WHERE status = 'IN_PROGRESS'`))[0].n, 2);
    env.core.reset();
    assert.equal((await run('2026-10-30T09:00:00+08:00')).closed, 2, 'the next run closes them');
  });

  it('a transaction completed while the job runs is left alone (guarded UPDATE)', async () => {
    await setLimits(1, 1, 1);
    const t = await insertTransaction(env.ds, { started_at: started });
    env.core.override('POST /deadline', () => {
      env.ds.query(`UPDATE transactions SET status = 'COMPLETED', ended_at = now() WHERE transaction_id = $1`, [t.transaction_id]);
      return { status: 200, body: { deadline: '2026-10-07T19:00:00+08:00' } };
    });
    const result = await run('2026-10-30T09:00:00+08:00');
    assert.equal(result.closed, 0);
    assert.equal((await stateOf(t.transaction_id)).status, 'COMPLETED');
    assert.equal((await audits('TRANSACTION_AUTO_CLOSED')).length, 0);
  });

  it('a threshold changed between runs applies to the next run', async () => {
    await setLimits(null, 5, null);
    const t = await insertTransaction(env.ds, { service_classification: 'COMPLEX', started_at: started });
    assert.equal((await run('2026-10-12T09:00:00+08:00')).closed, 0, '5 working days from Tue 10/06 ends Tue 10/13');
    await setLimits(null, 2, null);
    assert.equal((await run('2026-10-12T09:00:00+08:00')).closed, 1);
    assert.equal((await stateOf(t.transaction_id)).status, 'AUTO_CLOSED');
  });

  it('works through the oldest 100 open transactions per run', async () => {
    await setLimits(1, 1, 1);
    for (let i = 0; i < AUTO_CLOSE_BATCH + 3; i += 1) await insertTransaction(env.ds, { started_at: new Date(started.getTime() + i * 60_000) });
    assert.deepEqual(await run('2026-10-30T09:00:00+08:00'), { checked: AUTO_CLOSE_BATCH, closed: AUTO_CLOSE_BATCH, skipped: 0 });
    assert.deepEqual(await run('2026-10-30T09:00:00+08:00'), { checked: 3, closed: 3, skipped: 0 });
  });

  it('the route needs the cron secret and answers { job, checked, closed, skipped }', async () => {
    const callRoute = (auth) => autoCloseRoute(new Request('http://x/api/jobs/auto-close', { headers: auth ? { authorization: auth } : {} }));
    assert.equal((await callRoute()).status, 401);
    process.env.CRON_SECRET = 'cron-secret';
    try {
      const ok = await callRoute('Bearer cron-secret');
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { job: 'auto-close', checked: 0, closed: 0, skipped: 0 });
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});
