// CC025: Cancel a transaction with a reason (Office Head of the office and Super Admin only).
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { POST as cancelRoute } from '../src/app/api/transactions/[id]/cancel/route.js';
import { POST as completeRoute } from '../src/app/api/transactions/[id]/complete/route.js';
import { POST as startRoute } from '../src/app/api/transactions/route.js';
import { OFFICE_A, SERVICE_A, USERS, call, ctx, insertTransaction, req, resetData, seedCoreServices, setupTestEnv, tokens } from './helpers.js';

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

const cancel = (id, reason = 'Client withdrew the request', token = tokens.officeHeadA) => call(cancelRoute, req('POST', `/transactions/${id}/cancel`, { token, body: { reason } }), ctx(id));
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);
const stateOf = async (id) => (await env.ds.query('SELECT * FROM transactions WHERE transaction_id = $1', [id]))[0];

describe('CC025 cancel', () => {
  it('AC1: Office Head (own office) and Super Admin cancel an in-progress transaction; the reason is saved, the end time stays empty', async () => {
    const t = await insertTransaction(env.ds);
    const r = await cancel(t.transaction_id, '  Client withdrew the request  ');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'CANCELLED');
    assert.equal(r.body.cancel_reason, 'Client withdrew the request');
    assert.equal(r.body.ended_at, null);
    assert.equal(r.body.elapsed_working_minutes, null);
    assert.equal(r.body.is_compliant, null, 'excluded from compliance: no result');
    const t2 = await insertTransaction(env.ds);
    assert.equal((await cancel(t2.transaction_id, 'Started by mistake', tokens.superAdmin)).status, 200);
  });

  it('from ON_HOLD: the hold is cleared and no held minutes are added', async () => {
    const t = await insertTransaction(env.ds, { status: 'ON_HOLD', hold_started_at: new Date(Date.now() - 3600_000), held_minutes: 12, hold_reason: 'Waiting' });
    const r = await cancel(t.transaction_id);
    assert.equal(r.status, 200);
    const row = await stateOf(t.transaction_id);
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.hold_started_at, null);
    assert.equal(row.held_minutes, 12);
  });

  it('a reason of 1 to 500 characters is required', async () => {
    const t = await insertTransaction(env.ds);
    for (const reason of ['', '  ', null, 7, 'x'.repeat(501)]) {
      const r = await cancel(t.transaction_id, reason);
      assert.equal(r.status, 400, String(reason));
      assert.equal(r.body.error.details.reason, 'Enter a reason for cancelling');
    }
    assert.equal((await stateOf(t.transaction_id)).status, 'IN_PROGRESS');
    assert.equal((await cancel(t.transaction_id, 'x'.repeat(500))).status, 200);
  });

  it('AC3: Office Staff cannot cancel (403), not even their own; Executive 403; an Office Head of another office 403', async () => {
    const t = await insertTransaction(env.ds, { started_by: USERS.staffA });
    for (const token of [tokens.officeStaffA, tokens.officeStaffA2, tokens.executive, tokens.officeHeadB]) {
      const r = await cancel(t.transaction_id, 'x', token);
      assert.equal(r.status, 403);
      assert.ok(!JSON.stringify(r.body).includes(t.tracking_no));
    }
    assert.equal((await stateOf(t.transaction_id)).status, 'IN_PROGRESS');
    assert.equal((await call(cancelRoute, new Request('http://x/api', { method: 'POST', body: '{"reason":"x"}' }), ctx(t.transaction_id))).status, 401);
  });

  it('AC4: a completed, cancelled or auto-closed transaction cannot be cancelled (409)', async () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'AUTO_CLOSED']) {
      const t = await insertTransaction(env.ds, { status, ended_at: status === 'COMPLETED' ? new Date() : null, cancel_reason: status === 'CANCELLED' ? 'x' : null });
      const r = await cancel(t.transaction_id);
      assert.equal(r.status, 409, status);
      assert.equal(r.body.error.code, 'INVALID_STATE');
      assert.equal(r.body.error.message, 'Only open transactions can be cancelled');
      assert.equal((await stateOf(t.transaction_id)).status, status);
    }
  });

  it('AC5: cancelling is audited with the status and the reason, for the office of the transaction', async () => {
    const t = await insertTransaction(env.ds);
    await cancel(t.transaction_id, 'Client withdrew the request');
    const [event] = (await audits('TRANSACTION_CANCELLED')).map((x) => x.payload);
    assert.equal(event.entity_id, t.transaction_id);
    assert.equal(event.office_id, OFFICE_A);
    assert.equal(event.actor_user_id, USERS.headA);
    assert.deepEqual(event.before_value, { status: 'IN_PROGRESS' });
    assert.deepEqual(event.after_value, { status: 'CANCELLED', reason: 'Client withdrew the request' });
  });

  it('cancelling frees the staff\'s open slot', async () => {
    const started = await call(startRoute, req('POST', '/transactions', { token: tokens.officeStaffA, body: { service_id: SERVICE_A, client_type: 'STUDENT', requirements_confirmed: true } }));
    assert.equal(started.status, 201);
    const blocked = await call(startRoute, req('POST', '/transactions', { token: tokens.officeStaffA, body: { service_id: SERVICE_A, client_type: 'STUDENT', requirements_confirmed: true } }));
    assert.equal(blocked.status, 409);
    assert.equal((await cancel(started.body.transaction_id)).status, 200);
    const again = await call(startRoute, req('POST', '/transactions', { token: tokens.officeStaffA, body: { service_id: SERVICE_A, client_type: 'STUDENT', requirements_confirmed: true } }));
    assert.equal(again.status, 201);
  });

  it('Cancel and Complete at the same moment: whichever commits first wins, the other gets 409', async () => {
    const t = await insertTransaction(env.ds, { started_by: USERS.staffA });
    const [c, d] = await Promise.all([
      cancel(t.transaction_id),
      call(completeRoute, req('POST', `/transactions/${t.transaction_id}/complete`, { token: tokens.officeStaffA }), ctx(t.transaction_id)),
    ]);
    assert.deepEqual([c.status, d.status].sort(), [200, 409]);
    const row = await stateOf(t.transaction_id);
    assert.ok(['CANCELLED', 'COMPLETED'].includes(row.status));
    assert.equal(row.status === 'CANCELLED', c.status === 200);
  });

  it('404 for an unknown transaction', async () => {
    assert.equal((await cancel('11111111-1111-4111-8111-111111111111')).status, 404);
    assert.equal((await cancel('nope')).status, 404);
  });

  it('the database requires a reason for every cancelled row (CHECK)', async () => {
    const t = await insertTransaction(env.ds);
    await assert.rejects(env.ds.query(`UPDATE transactions SET status = 'CANCELLED' WHERE transaction_id = $1`, [t.transaction_id]), /transactions_cancel_reason_ck/);
    await assert.rejects(env.ds.query(`UPDATE transactions SET status = 'CANCELLED', cancel_reason = '   ' WHERE transaction_id = $1`, [t.transaction_id]), /transactions_cancel_reason_ck/);
  });
});

runBoundarySuite({
  name: 'operations cancel',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'POST /transactions/:id/cancel',
      write: true,
      superAdminOnly: false,
      officeScoped: true,
      invoke: async (token, target) => {
        const t = await insertTransaction(env.ds, { office_id: target === 'own' ? OFFICE_A : '22222222-2222-4222-8222-222222222222' });
        const r = await cancel(t.transaction_id, 'Boundary check', token);
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    },
  ],
});
