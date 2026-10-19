// CC026: record a transaction after the fact (backdated start and end), always with a reason, always flagged and audited.
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { POST as completeRoute } from '../src/app/api/transactions/[id]/complete/route.js';
import { POST as startRoute } from '../src/app/api/transactions/route.js';
import { OFFICE_A, SERVICE_A, SERVICE_B, USERS, at, call, ctx, insertTransaction, req, resetData, seedCoreServices, setupTestEnv, tokens } from './helpers.js';

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

const iso = (date, time) => `${date}T${time}:00+08:00`;
const body = (over = {}) => ({ service_id: SERVICE_A, client_type: 'STUDENT', requirements_confirmed: true, ...over });
const start = (over = {}, token = tokens.officeStaffA) => call(startRoute, req('POST', '/transactions', { token, body: body(over) }));
const complete = (id, payload, token = tokens.officeStaffA) => call(completeRoute, req('POST', `/transactions/${id}/complete`, { token, body: payload }), ctx(id));
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);

describe('CC026 backdated start', () => {
  it('AC1/AC2: a supplied start needs a reason; the entry is flagged backdated and audited with the field, value and reason', async () => {
    const r = await start({ started_at: iso('2026-10-06', '10:00'), backdate_reason: 'Catalogue outage' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.is_backdated, true);
    assert.equal(r.body.backdate_reason, 'Catalogue outage');
    assert.equal(r.body.started_at, '2026-10-06T02:00:00.000Z');
    assert.equal(r.body.status, 'IN_PROGRESS');
    const [backdated] = (await audits('TRANSACTION_BACKDATED')).map((x) => x.payload);
    assert.deepEqual(backdated.after_value, { field: 'started_at', value: '2026-10-06T02:00:00.000Z', reason: 'Catalogue outage' });
    assert.equal((await audits('TRANSACTION_STARTED')).length, 1, 'plus the normal STARTED event');
    for (const backdate_reason of [undefined, '', '   ', 'x'.repeat(501)]) {
      const bad = await start({ started_at: iso('2026-10-06', '10:00'), backdate_reason }, tokens.officeStaffA2);
      assert.equal(bad.status, 400, String(backdate_reason));
      assert.equal(bad.body.error.details.backdate_reason, 'Enter why this time is entered after the fact');
    }
  });

  it('AC4: the standard in force on the Manila date of the start is used, and the tracking date is that date', async () => {
    const svc = env.core.state.services.get(SERVICE_A);
    svc.standards = [
      { from: '2025-01-01', to: '2026-09-30', standard_id: '00000000-0000-4000-8000-000000000001', days: 5, hours: 0, minutes: 0 },
      { from: '2026-10-01', to: null, standard_id: '00000000-0000-4000-8000-000000000002', days: 3, hours: 0, minutes: 0 },
    ];
    const old = await start({ started_at: iso('2026-09-15', '09:00'), backdate_reason: 'Outage' });
    assert.equal(old.status, 201);
    assert.equal(old.body.standard_duration_days, 5);
    assert.equal(old.body.standard_id, '00000000-0000-4000-8000-000000000001');
    assert.equal(old.body.tracking_no, 'PUP-OSAS-20260915-0001');
    assert.equal(env.core.callsTo('GET', '/standard').at(-1).query.asOf, '2026-09-15');
    await env.ds.query(`UPDATE transactions SET status = 'CANCELLED', cancel_reason = 'x', hold_started_at = NULL`);
    const current = await start({ started_at: iso('2026-10-02', '09:00'), backdate_reason: 'Outage' });
    assert.equal(current.body.standard_duration_days, 3);
    assert.equal(current.body.tracking_no, 'PUP-OSAS-20261002-0001');
    seedCoreServices(env.core);
  });

  it('a start on a date with no standard yet is refused with the date in the message', async () => {
    const r = await start({ started_at: iso('2024-06-01', '09:00'), backdate_reason: 'Old paperwork' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'STANDARD_NOT_IN_FORCE');
    assert.equal(r.body.error.message, 'No standard was in force for this service on 06/01/2024');
  });

  it('AC3: times in the future, an unreadable time, or an end before the start are refused', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const f = await start({ started_at: future, backdate_reason: 'x' });
    assert.equal(f.status, 400);
    assert.equal(f.body.error.details.started_at, 'Time cannot be in the future');
    assert.equal((await start({ started_at: '2026-10-06 10:00', backdate_reason: 'x' })).body.error.details.started_at, 'Enter the start as a date and time');
    assert.equal((await start({ started_at: '2026-10-06T10:00:00', backdate_reason: 'x' })).status, 400, 'a time without an offset is refused');
    const e = await start({ started_at: iso('2026-10-06', '10:00'), ended_at: iso('2026-10-06', '09:00'), backdate_reason: 'x' });
    assert.equal(e.body.error.details.ended_at, 'End must be after start');
    const same = await start({ started_at: iso('2026-10-06', '10:00'), ended_at: iso('2026-10-06', '10:00'), backdate_reason: 'x' });
    assert.equal(same.body.error.details.ended_at, 'End must be after start');
    const futureEnd = await start({ started_at: iso('2026-10-06', '10:00'), ended_at: future, backdate_reason: 'x' });
    assert.equal(futureEnd.body.error.details.ended_at, 'Time cannot be in the future');
    const endOnly = await start({ ended_at: iso('2026-10-06', '10:00'), backdate_reason: 'x' });
    assert.equal(endOnly.status, 400);
    assert.ok(endOnly.body.error.details.started_at);
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM transactions'))[0].n, 0);
  });

  it('the one-open rule applies to an open backdated start', async () => {
    assert.equal((await start({ started_at: iso('2026-10-06', '10:00'), backdate_reason: 'x' })).status, 201);
    const second = await start({ started_at: iso('2026-10-06', '11:00'), backdate_reason: 'x' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'OPEN_TRANSACTION_EXISTS');
  });

  it('start and end in one call records a finished transaction with its result', async () => {
    const r = await start({ service_id: SERVICE_B, started_at: iso('2026-10-06', '10:00'), ended_at: iso('2026-10-06', '10:45'), backdate_reason: 'Outage', client_email: 'x@example.com' }, tokens.officeStaffB);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'COMPLETED');
    assert.equal(r.body.ended_at, '2026-10-06T02:45:00.000Z');
    assert.equal(r.body.ended_by, USERS.staffB);
    assert.deepEqual([r.body.elapsed_working_minutes, r.body.is_compliant, r.body.variance_minutes], [45, true, -15]);
    assert.equal(r.body.is_backdated, true);
    assert.equal(r.body.receipt_email_status, 'PENDING');
    assert.deepEqual((await audits('TRANSACTION_BACKDATED')).map((x) => x.payload.after_value.field), ['started_at', 'ended_at']);
    assert.equal((await audits('TRANSACTION_COMPLETED')).length, 1);
    assert.equal((await audits('TRANSACTION_RESULT_COMPUTED')).length, 1);
    const next = await start({ service_id: SERVICE_B }, tokens.officeStaffB);
    assert.equal(next.status, 201, 'a finished entry does not block the staff');
  });

  it('start and end in one call with Core down: recorded, result pending', async () => {
    env.core.setMode('drop');
    const r = await start({ started_at: iso('2026-10-06', '10:00'), ended_at: iso('2026-10-06', '10:45'), backdate_reason: 'Outage' });
    assert.equal(r.status, 503, 'the standard cannot be looked up while Catalogue is down');
    env.core.reset();
    env.core.override('POST /deadline', () => ({ status: 503, body: {} }));
    const ok = await start({ started_at: iso('2026-10-06', '10:00'), ended_at: iso('2026-10-06', '10:45'), backdate_reason: 'Outage' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.status, 'COMPLETED');
    assert.equal(ok.body.is_compliant, null);
  });
});

describe('CC026 backdated end', () => {
  it('Complete with ended_at and a reason: flagged backdated, audited, and the result uses the given end', async () => {
    const t = await insertTransaction(env.ds, { started_by: USERS.staffA, started_at: new Date(at('2026-10-06', '10:00')) });
    const r = await complete(t.transaction_id, { ended_at: iso('2026-10-09', '18:00'), backdate_reason: 'Forgot to click' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.is_backdated, true);
    assert.equal(r.body.backdate_reason, 'Forgot to click');
    assert.equal(r.body.ended_at, '2026-10-09T10:00:00.000Z');
    assert.deepEqual([r.body.is_compliant, r.body.variance_minutes], [true, -60]);
    const [event] = (await audits('TRANSACTION_BACKDATED')).map((x) => x.payload);
    assert.deepEqual(event.after_value, { field: 'ended_at', value: '2026-10-09T10:00:00.000Z', reason: 'Forgot to click' });
    assert.equal((await audits('TRANSACTION_COMPLETED')).length, 1);
  });

  it('a reason is required, the end must be after the start and not in the future', async () => {
    const t = await insertTransaction(env.ds, { started_by: USERS.staffA, started_at: new Date(at('2026-10-06', '10:00')) });
    const noReason = await complete(t.transaction_id, { ended_at: iso('2026-10-06', '12:00') });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.details.backdate_reason, 'Enter why this time is entered after the fact');
    const before = await complete(t.transaction_id, { ended_at: iso('2026-10-06', '09:00'), backdate_reason: 'x' });
    assert.equal(before.body.error.details.ended_at, 'End must be after start');
    const future = await complete(t.transaction_id, { ended_at: new Date(Date.now() + 3600_000).toISOString(), backdate_reason: 'x' });
    assert.equal(future.body.error.details.ended_at, 'Time cannot be in the future');
    const startAgain = await complete(t.transaction_id, { started_at: iso('2026-10-05', '09:00'), backdate_reason: 'x' });
    assert.equal(startAgain.status, 400, 'the start cannot be changed on completion');
    assert.equal((await env.ds.query('SELECT status FROM transactions WHERE transaction_id = $1', [t.transaction_id]))[0].status, 'IN_PROGRESS');
  });

  it('both reasons are kept when the start and the end were both entered by hand', async () => {
    const started = await start({ started_at: iso('2026-10-06', '10:00'), backdate_reason: 'Start entered late' });
    const r = await complete(started.body.transaction_id, { ended_at: iso('2026-10-09', '18:00'), backdate_reason: 'End entered late' });
    assert.equal(r.body.backdate_reason, 'Start entered late\nEnd entered late');
    assert.equal(r.body.is_backdated, true);
  });

  it('a normal completion does not flag the entry', async () => {
    const t = await insertTransaction(env.ds, { started_by: USERS.staffA, office_id: OFFICE_A });
    const r = await complete(t.transaction_id);
    assert.equal(r.body.is_backdated, false);
    assert.equal(r.body.backdate_reason, null);
  });
});
