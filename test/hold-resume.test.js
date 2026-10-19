// CC022: Hold and Resume (setting off by default), with the held time counted in working minutes by Core.
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { POST as holdRoute } from '../src/app/api/transactions/[id]/hold/route.js';
import { POST as resumeRoute } from '../src/app/api/transactions/[id]/resume/route.js';
import { createCoreClient } from '../src/modules/transaction/core-client.js';
import { resumeTransaction } from '../src/modules/transaction/hold.js';
import { OFFICE_A, USERS, at, call, ctx, head, insertTransaction, req, resetData, seedCoreServices, setupTestEnv, staff, tokens } from './helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  seedCoreServices(env.core);
});
after(async () => env?.teardown());
beforeEach(async () => {
  env.core.reset();
  await resetData(env.ds);
  await env.ds.query('UPDATE transaction_settings SET hold_enabled = true');
});

const hold = (id, reason = 'Waiting for the signed form', token = tokens.officeStaffA) => call(holdRoute, req('POST', `/transactions/${id}/hold`, { token, body: { reason } }), ctx(id));
const resume = (id, token = tokens.officeStaffA) => call(resumeRoute, req('POST', `/transactions/${id}/resume`, { token }), ctx(id));
const mine = (over = {}) => insertTransaction(env.ds, { started_by: USERS.staffA, ...over });
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);
const stateOf = async (id) => (await env.ds.query('SELECT * FROM transactions WHERE transaction_id = $1', [id]))[0];

describe('CC022 hold', () => {
  it('AC1: with the hold setting off it is refused (409 HOLD_DISABLED) and nothing changes', async () => {
    await env.ds.query('UPDATE transaction_settings SET hold_enabled = false');
    const t = await mine();
    const r = await hold(t.transaction_id);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'HOLD_DISABLED');
    assert.equal(r.body.error.message, 'Hold is turned off for this institution');
    assert.equal((await stateOf(t.transaction_id)).status, 'IN_PROGRESS');
  });

  it('AC2: a reason of 1 to 500 characters is required', async () => {
    const t = await mine();
    for (const reason of ['', '   ', null, 5, 'x'.repeat(501)]) {
      const r = await hold(t.transaction_id, reason);
      assert.equal(r.status, 400, String(reason));
      assert.equal(r.body.error.details.reason, 'Enter a reason for the hold');
    }
    assert.equal((await hold(t.transaction_id, `  ${'x'.repeat(500)}  `)).status, 200);
  });

  it('puts an in-progress transaction on hold: status, start of the hold and reason are saved and audited', async () => {
    const t = await mine();
    const r = await hold(t.transaction_id, '  Missing signature  ');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ON_HOLD');
    assert.equal(r.body.hold_reason, 'Missing signature');
    assert.ok(r.body.hold_started_at);
    assert.equal(r.body.version, 2);
    const [event] = (await audits('TRANSACTION_HELD')).map((x) => x.payload);
    assert.equal(event.entity_id, t.transaction_id);
    assert.equal(event.office_id, OFFICE_A);
    assert.equal(event.after_value.hold_reason, 'Missing signature');
    assert.equal(event.after_value.hold_started_at, r.body.hold_started_at);
  });

  it('AC4: only one open hold at a time: a transaction already on hold cannot be put on hold again', async () => {
    const t = await mine();
    await hold(t.transaction_id);
    const again = await hold(t.transaction_id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVALID_STATE');
    assert.equal(again.body.error.message, 'This transaction is not in progress');
    for (const status of ['COMPLETED', 'CANCELLED', 'AUTO_CLOSED']) {
      const done = await insertTransaction(env.ds, { status, ended_at: status === 'COMPLETED' ? new Date() : null, cancel_reason: status === 'CANCELLED' ? 'x' : null });
      assert.equal((await hold(done.transaction_id, 'x', tokens.superAdmin)).status, 409, status);
    }
  });

  it('the DB keeps ON_HOLD and hold_started_at together (CHECK)', async () => {
    const t = await mine();
    await assert.rejects(env.ds.query(`UPDATE transactions SET status = 'ON_HOLD' WHERE transaction_id = $1`, [t.transaction_id]), /transactions_hold_ck/);
    await assert.rejects(env.ds.query(`UPDATE transactions SET hold_started_at = now() WHERE transaction_id = $1`, [t.transaction_id]), /transactions_hold_ck/);
  });

  it('who may hold: the staff who started it, the Office Head of the office, Super Admin; not another staff, another office or Executive', async () => {
    const t = await mine();
    assert.equal((await hold(t.transaction_id, 'x', tokens.officeStaffA2)).status, 403);
    assert.equal((await hold(t.transaction_id, 'x', tokens.officeHeadB)).status, 403);
    assert.equal((await hold(t.transaction_id, 'x', tokens.officeStaffB)).status, 403);
    assert.equal((await hold(t.transaction_id, 'x', tokens.executive)).status, 403);
    assert.equal((await call(holdRoute, new Request('http://x/api', { method: 'POST', body: '{}' }), ctx(t.transaction_id))).status, 401);
    assert.equal((await hold(t.transaction_id, 'x', tokens.officeHeadA)).status, 200);
    const t2 = await insertTransaction(env.ds);
    assert.equal((await hold(t2.transaction_id, 'x', tokens.superAdmin)).status, 200);
    assert.equal((await hold('11111111-1111-4111-8111-111111111111')).status, 404);
    assert.equal((await hold('not-a-uuid')).status, 404);
  });
});

describe('CC022 resume', () => {
  const deps = (nowIso) => ({ core: createCoreClient(), now: () => new Date(nowIso) });

  it('AC3/TC4-TXN-022: adds the working minutes of the hold (Fri 18:30 to Tue 09:00 = 30 + 540 + 60), clears the hold, returns to In Progress', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(at('2026-10-09', '18:30')), hold_reason: 'Waiting for the signed form' });
    const r = await resumeTransaction(env.ds, deps('2026-10-13T09:00:00+08:00'), staff(USERS.staffA), t.transaction_id);
    assert.equal(r.status, 'IN_PROGRESS');
    assert.equal(r.held_minutes, 630);
    assert.equal(r.hold_started_at, null);
    assert.equal(r.hold_reason, 'Waiting for the signed form', 'the last reason stays on the record');
    const call1 = env.core.callsTo('POST', '/working-minutes')[0];
    assert.deepEqual(call1.body, { start: '2026-10-09T10:30:00.000Z', end: '2026-10-13T01:00:00.000Z', officeId: OFFICE_A });
    assert.equal(call1.headers['x-service-key'], 'test-service-key-0123456789');
    const [event] = (await audits('TRANSACTION_RESUMED')).map((x) => x.payload);
    assert.equal(event.before_value.held_minutes, 0);
    assert.equal(event.after_value.held_minutes, 630);
    assert.equal(event.after_value.added_minutes, 630);
  });

  it('the held total is a running total across holds', async () => {
    const t = await mine({ status: 'ON_HOLD', held_minutes: 100, hold_started_at: new Date(at('2026-10-06', '10:00')) });
    const r = await resumeTransaction(env.ds, deps('2026-10-06T11:30:00+08:00'), staff(USERS.staffA), t.transaction_id);
    assert.equal(r.held_minutes, 190);
  });

  it('held time outside working hours counts as 0', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(at('2026-10-11', '10:00')) }); // a Sunday
    const r = await resumeTransaction(env.ds, deps('2026-10-11T15:00:00+08:00'), staff(USERS.staffA), t.transaction_id);
    assert.equal(r.held_minutes, 0);
    assert.equal(r.status, 'IN_PROGRESS');
  });

  it('a hold that lasted less than a millisecond adds 0 without asking Core', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(at('2026-10-06', '10:00')) });
    const r = await resumeTransaction(env.ds, deps('2026-10-06T10:00:00+08:00'), staff(USERS.staffA), t.transaction_id);
    assert.equal(r.held_minutes, 0);
    assert.equal(env.core.callsTo('POST', '/working-minutes').length, 0);
  });

  it('AC6: if Core cannot be reached the transaction stays on hold and a retry message is shown (503); nothing changes', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(at('2026-10-06', '10:00')), held_minutes: 5 });
    env.core.setMode('down');
    await assert.rejects(resumeTransaction(env.ds, deps('2026-10-06T12:00:00+08:00'), staff(USERS.staffA), t.transaction_id), (err) => err.status === 503 && err.code === 'CALENDAR_UNAVAILABLE');
    const row = await stateOf(t.transaction_id);
    assert.equal(row.status, 'ON_HOLD');
    assert.equal(row.held_minutes, 5);
    assert.ok(row.hold_started_at);
    assert.equal(env.core.callsTo('POST', '/working-minutes').length, 2, 'one try and one retry');
    assert.equal((await audits('TRANSACTION_RESUMED')).length, 0);
  });

  it('the route answers 503 with the code when Core is down, and works once it is back', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(Date.now() - 3600_000) });
    env.core.setMode('down');
    const down = await resume(t.transaction_id);
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, 'CALENDAR_UNAVAILABLE');
    env.core.reset();
    const up = await resume(t.transaction_id);
    assert.equal(up.status, 200);
    assert.equal(up.body.status, 'IN_PROGRESS');
  });

  it('only an ON_HOLD transaction can be resumed; resuming twice quickly gives one success and one 409', async () => {
    const open = await mine();
    const notHeld = await resume(open.transaction_id);
    assert.equal(notHeld.status, 409);
    assert.equal(notHeld.body.error.message, 'This transaction is not on hold');
    const t = await insertTransaction(env.ds, { status: 'ON_HOLD', hold_started_at: new Date(Date.now() - 600_000) });
    const results = await Promise.all([resume(t.transaction_id, tokens.officeHeadA), resume(t.transaction_id, tokens.officeHeadA)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error.code, 'INVALID_STATE');
    assert.equal((await audits('TRANSACTION_RESUMED')).length, 1);
  });

  it('with the hold setting switched off while a transaction is on hold, Resume still works', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(Date.now() - 600_000) });
    await env.ds.query('UPDATE transaction_settings SET hold_enabled = false');
    assert.equal((await resume(t.transaction_id)).status, 200);
  });

  it('who may resume: the staff who started it, the Office Head of the office, Super Admin', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(Date.now() - 600_000) });
    assert.equal((await resume(t.transaction_id, tokens.officeStaffA2)).status, 403);
    assert.equal((await resume(t.transaction_id, tokens.officeHeadB)).status, 403);
    assert.equal((await resume(t.transaction_id, tokens.executive)).status, 403);
    assert.equal((await resume(t.transaction_id, tokens.superAdmin)).status, 200);
    assert.equal((await resume('11111111-1111-4111-8111-111111111111')).status, 404);
  });

  it('a head of the office can act on staff transactions, a head of another office cannot', async () => {
    const t = await mine({ status: 'ON_HOLD', hold_started_at: new Date(Date.now() - 600_000) });
    const r = await resumeTransaction(env.ds, { core: createCoreClient(), now: () => new Date() }, head(USERS.headA), t.transaction_id);
    assert.equal(r.status, 'IN_PROGRESS');
  });
});
