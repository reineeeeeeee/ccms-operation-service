// CC023: complete a transaction, save the end time at the click, compute compliance, and fill in a pending result later.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { POST as completeRoute } from '../src/app/api/transactions/[id]/complete/route.js';
import { GET as computePendingRoute } from '../src/app/api/jobs/compute-pending/route.js';
import { runComputePending } from '../src/jobs/compute-pending.js';
import { COMPUTE_BATCH } from '../src/modules/transaction/compute-pending.js';
import { createCoreClient } from '../src/modules/transaction/core-client.js';
import { computeAndStoreResult, completeTransaction } from '../src/modules/transaction/complete.js';
import { OFFICE_A, OFFICE_B, SERVICE_B, USERS, at, call, ctx, insertTransaction, req, resetData, seedCoreServices, setupTestEnv, staff, tokens } from './helpers.js';

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

const complete = (id, token = tokens.officeStaffA, body) => call(completeRoute, req('POST', `/transactions/${id}/complete`, { token, body }), ctx(id));
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);
const stateOf = async (id) => (await env.ds.query('SELECT * FROM transactions WHERE transaction_id = $1', [id]))[0];
const deps = (nowIso) => ({ core: createCoreClient(), now: () => new Date(nowIso) });
const mine = (over = {}) => insertTransaction(env.ds, { started_by: USERS.staffA, ...over });
// Service B of the tests: no days, 1 hour. Service A: 3 working days.
const hourly = { service_id: SERVICE_B, office_id: OFFICE_B, standard_duration_days: 0, standard_duration_hours: 1, standard_duration_minutes: 0 };

describe('CC023 complete', () => {
  it('AC1/AC3: saves ended_at at the click, computes elapsed working minutes, compliance and variance', async () => {
    const t = await mine({ ...hourly, office_id: OFFICE_A, started_at: new Date(at('2026-10-06', '10:00')) });
    const done = await completeTransaction(env.ds, deps('2026-10-06T10:45:00+08:00'), staff(USERS.staffA), t.transaction_id, {});
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.ended_at, '2026-10-06T02:45:00.000Z');
    assert.equal(done.ended_by, USERS.staffA);
    assert.deepEqual([done.elapsed_working_minutes, done.is_compliant, done.variance_minutes], [45, true, -15]);
    const row = await stateOf(t.transaction_id);
    assert.equal(row.version, 3, 'one version for the completion and one for the result');
  });

  it('a breach is recorded as such', async () => {
    const t = await mine({ ...hourly, office_id: OFFICE_A, started_at: new Date(at('2026-10-06', '10:00')) });
    const done = await completeTransaction(env.ds, deps('2026-10-06T11:30:00+08:00'), staff(USERS.staffA), t.transaction_id, {});
    assert.deepEqual([done.elapsed_working_minutes, done.is_compliant, done.variance_minutes], [90, false, 30]);
  });

  it('days standard: the deadline and the added minutes come from Core (3 working days from Tue -> Fri 19:00)', async () => {
    const t = await mine({ started_at: new Date(at('2026-10-06', '10:00')) });
    const done = await completeTransaction(env.ds, deps('2026-10-09T18:00:00+08:00'), staff(USERS.staffA), t.transaction_id, {});
    assert.deepEqual([done.is_compliant, done.variance_minutes], [true, -60]);
    assert.deepEqual(env.core.callsTo('POST', '/deadline')[0].body.heldMinutes, 0);
    const add = env.core.callsTo('POST', '/add-working-minutes')[0].body;
    assert.equal(add.minutes, 0);
    assert.equal(add.datetime, '2026-10-09T11:00:00.000Z', 'D1 is Fri 19:00 Manila');
    assert.equal(add.officeId, OFFICE_A);
  });

  it('AC4: completing asks for nothing twice: a second completion is a 409 with the current status', async () => {
    const t = await mine();
    assert.equal((await complete(t.transaction_id)).status, 200);
    const again = await complete(t.transaction_id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVALID_STATE');
    assert.equal(again.body.error.message, 'This transaction is already completed');
    assert.equal(again.body.error.details.status, 'COMPLETED');
    assert.equal((await audits('TRANSACTION_COMPLETED')).length, 1);
  });

  it('AC5: an on-hold transaction must be resumed first; cancelled and auto-closed ones say what they are', async () => {
    const held = await mine({ status: 'ON_HOLD', hold_started_at: new Date() });
    const r = await complete(held.transaction_id);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, 'Resume the transaction before completing it');
    assert.equal((await stateOf(held.transaction_id)).status, 'ON_HOLD');
    const cancelled = await insertTransaction(env.ds, { status: 'CANCELLED', cancel_reason: 'x' });
    assert.equal((await complete(cancelled.transaction_id, tokens.superAdmin)).body.error.message, 'This transaction is already cancelled');
    const closed = await insertTransaction(env.ds, { status: 'AUTO_CLOSED' });
    assert.equal((await complete(closed.transaction_id, tokens.superAdmin)).body.error.message, 'This transaction is already auto-closed');
  });

  it('AC2: the end time is saved even if Calendar is down; the answer says the result is pending (null) and it is filled in on recovery', async () => {
    const t = await mine({ started_at: new Date(at('2026-10-06', '10:00')) });
    env.core.setMode('down');
    const done = await completeTransaction(env.ds, deps('2026-10-09T18:00:00+08:00'), staff(USERS.staffA), t.transaction_id, {});
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.ended_at, '2026-10-09T10:00:00.000Z');
    assert.deepEqual([done.elapsed_working_minutes, done.is_compliant, done.variance_minutes], [null, null, null]);
    assert.equal((await audits('TRANSACTION_COMPLETED')).length, 1);
    assert.equal((await audits('TRANSACTION_RESULT_COMPUTED')).length, 0);

    env.core.reset();
    const run = await runComputePending();
    assert.deepEqual(run, { checked: 1, computed: 1, skipped: 0 });
    const row = await stateOf(t.transaction_id);
    assert.deepEqual([row.elapsed_working_minutes, row.is_compliant, row.variance_minutes], [2460, true, -60]);
    const [event] = (await audits('TRANSACTION_RESULT_COMPUTED')).map((x) => x.payload);
    assert.equal(event.actor_role, 'system');
    assert.equal(event.actor_user_id, null);
    assert.equal(event.office_id, OFFICE_A);
    assert.deepEqual(event.after_value, { elapsed_working_minutes: 2460, is_compliant: true, variance_minutes: -60 });
    assert.equal(row.ended_at.toISOString(), '2026-10-09T10:00:00.000Z', 'the end time was not touched');
  });

  it('a Core answer that is not usable counts as a failure: the result stays pending', async () => {
    const t = await mine({ ...hourly, office_id: OFFICE_A, started_at: new Date(at('2026-10-06', '10:00')) });
    env.core.override('POST /working-minutes', () => ({ status: 200, body: { working_minutes: 'many' } }));
    const done = await completeTransaction(env.ds, deps('2026-10-06T10:45:00+08:00'), staff(USERS.staffA), t.transaction_id, {});
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.is_compliant, null);
    env.core.override('POST /working-minutes', () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'bad' } } }));
    const t2 = await insertTransaction(env.ds, { ...hourly, office_id: OFFICE_A, status: 'COMPLETED', started_at: new Date(at('2026-10-06', '10:00')), ended_at: new Date(at('2026-10-06', '10:30')) });
    assert.deepEqual(await runComputePending(), { checked: 2, computed: 0, skipped: 2 });
    assert.equal((await stateOf(t2.transaction_id)).elapsed_working_minutes, null);
  });

  it('the job and a manual retry computing at the same time write once (guarded UPDATE)', async () => {
    const t = await insertTransaction(env.ds, { ...hourly, office_id: OFFICE_A, status: 'COMPLETED', started_at: new Date(at('2026-10-06', '10:00')), ended_at: new Date(at('2026-10-06', '10:30')) });
    const core = createCoreClient();
    const row = await stateOf(t.transaction_id);
    const results = await Promise.all([computeAndStoreResult(env.ds, core, row, { system: true }), computeAndStoreResult(env.ds, core, row, { actor: staff(USERS.staffA) })]);
    assert.equal(results.filter((r) => r.computed).length, 1);
    assert.equal((await audits('TRANSACTION_RESULT_COMPUTED')).length, 1);
    assert.equal((await stateOf(t.transaction_id)).elapsed_working_minutes, 30);
  });

  it('compute-pending: 50 per run, oldest first; running again changes nothing already done; cancelled rows are never picked', async () => {
    for (let i = 0; i < COMPUTE_BATCH + 5; i += 1) {
      await insertTransaction(env.ds, { ...hourly, office_id: OFFICE_A, status: 'COMPLETED', started_at: new Date(at('2026-10-06', '10:00')), ended_at: new Date(at('2026-10-06', '10:30')) });
    }
    await insertTransaction(env.ds, { status: 'CANCELLED', cancel_reason: 'x' });
    assert.deepEqual(await runComputePending(), { checked: COMPUTE_BATCH, computed: COMPUTE_BATCH, skipped: 0 });
    assert.deepEqual(await runComputePending(), { checked: 5, computed: 5, skipped: 0 });
    assert.deepEqual(await runComputePending(), { checked: 0, computed: 0, skipped: 0 });
    assert.equal((await audits('TRANSACTION_RESULT_COMPUTED')).length, COMPUTE_BATCH + 5);
  });

  it('the compute-pending route needs the cron secret and returns { job, checked, computed, skipped }', async () => {
    const call1 = (auth) => computePendingRoute(new Request('http://x/api/jobs/compute-pending', { headers: auth ? { authorization: auth } : {} }));
    assert.equal((await call1()).status, 401);
    process.env.CRON_SECRET = 'cron-secret';
    try {
      assert.equal((await call1('Bearer wrong')).status, 401);
      const ok = await call1('Bearer cron-secret');
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { job: 'compute-pending', checked: 0, computed: 0, skipped: 0 });
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it('AC6: with Core up the whole completion answers in under 2 seconds', async () => {
    const t = await mine({ started_at: new Date(Date.now() - 3 * 86_400_000) });
    const started = performance.now();
    const r = await complete(t.transaction_id);
    const took = performance.now() - started;
    assert.equal(r.status, 200);
    assert.notEqual(r.body.is_compliant, null);
    assert.ok(took < 2000, `took ${Math.round(took)} ms`);
  });

  it('two Complete clicks at the same moment: one 200, one 409, one audit entry', async () => {
    const t = await mine();
    const results = await Promise.all([complete(t.transaction_id), complete(t.transaction_id)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await audits('TRANSACTION_COMPLETED')).length, 1);
  });

  it('audits TRANSACTION_COMPLETED (after: ended_at) for the office', async () => {
    const t = await mine();
    const r = await complete(t.transaction_id);
    const [event] = (await audits('TRANSACTION_COMPLETED')).map((x) => x.payload);
    assert.equal(event.entity_id, t.transaction_id);
    assert.equal(event.office_id, OFFICE_A);
    assert.equal(event.actor_user_id, USERS.staffA);
    assert.equal(event.after_value.ended_at, r.body.ended_at);
    assert.equal(event.after_value.status, 'COMPLETED');
  });

  it('who may complete: the staff who started it, the Office Head of the office, Super Admin; nobody else', async () => {
    const t = await mine();
    assert.equal((await complete(t.transaction_id, tokens.officeStaffA2)).status, 403);
    assert.equal((await complete(t.transaction_id, tokens.officeHeadB)).status, 403);
    assert.equal((await complete(t.transaction_id, tokens.executive)).status, 403);
    assert.equal((await call(completeRoute, new Request('http://x/api', { method: 'POST' }), ctx(t.transaction_id))).status, 401);
    assert.equal((await complete(t.transaction_id, tokens.officeHeadA)).status, 200);
    const t2 = await insertTransaction(env.ds);
    assert.equal((await complete(t2.transaction_id, tokens.superAdmin)).status, 200);
    assert.equal((await complete(randomUUID())).status, 404);
    assert.equal((await complete('nope')).status, 404);
  });

  it('accepts an empty body and a body of {}', async () => {
    const a = await mine();
    assert.equal((await complete(a.transaction_id, tokens.officeStaffA, undefined)).status, 200);
    const b = await insertTransaction(env.ds, { started_by: USERS.staffA2 });
    assert.equal((await complete(b.transaction_id, tokens.officeStaffA2, {})).status, 200);
  });
});

runBoundarySuite({
  name: 'operations complete',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'POST /transactions/:id/complete',
      write: true,
      superAdminOnly: false,
      officeScoped: true,
      invoke: async (token, target) => {
        const t = await insertTransaction(env.ds, { office_id: target === 'own' ? OFFICE_A : OFFICE_B, started_by: randomUUID() });
        const r = await complete(t.transaction_id, token);
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    },
  ],
});
