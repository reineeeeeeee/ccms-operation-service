// CC021: start a transaction with the standard snapshot (AC1-AC9), plus the counter rule (B22) and the Manila date boundary.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ROLES } from 'ccms-shared';
import { runBoundarySuite } from 'ccms-shared/testing';
import { GET as getTransactionRoute } from '../src/app/api/transactions/[id]/route.js';
import { POST as startRoute } from '../src/app/api/transactions/route.js';
import { createCoreClient } from '../src/modules/transaction/core-client.js';
import { startTransaction } from '../src/modules/transaction/start.js';
import { OFFICE_A, OFFICE_B, SERVICE_A, SERVICE_B, USERS, call, ctx, req, resetData, seedCoreServices, setupTestEnv, tokens } from './helpers.js';

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

const body = (over = {}) => ({ service_id: SERVICE_A, client_type: 'STUDENT', client_reference: '2023-00123-QC-0', client_email: 'juan@example.com', requirements_confirmed: true, ...over });
const start = (over = {}, token = tokens.officeStaffA) => call(startRoute, req('POST', '/transactions', { token, body: body(over) }));
const rowCount = async () => (await env.ds.query('SELECT count(*)::int AS n FROM transactions'))[0].n;
const lastSeq = async () => (await env.ds.query('SELECT coalesce(max(last_seq), 0)::int AS n FROM tracking_sequences'))[0].n;
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);
const manilaDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(d).replaceAll('-', '');
const staffA = { id: USERS.staffA, role: ROLES.OFFICE_STAFF, officeId: OFFICE_A };

describe('CC021 start with the standard snapshot', () => {
  it('AC1: staff of the office start an active service; the standard in force is snapshotted and the status is In Progress', async () => {
    const before = Date.now();
    const r = await start();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const t = r.body;
    assert.equal(t.status, 'IN_PROGRESS');
    assert.equal(t.service_id, SERVICE_A);
    assert.equal(t.service_code, 'PUP-OSAS-TOR-001');
    assert.equal(t.service_name, 'Transcript of Records');
    assert.equal(t.service_classification, 'COMPLEX');
    assert.equal(t.office_id, OFFICE_A);
    assert.equal(t.office_code, 'PUP-OSAS');
    assert.deepEqual([t.standard_duration_days, t.standard_duration_hours, t.standard_duration_minutes], [3, 0, 0]);
    assert.equal(t.client_type, 'STUDENT');
    assert.equal(t.client_email, 'juan@example.com');
    assert.equal(t.started_by, USERS.staffA);
    assert.equal(t.counter_id, null);
    assert.equal(t.ended_at, null);
    assert.equal(t.is_backdated, false);
    assert.ok(Date.parse(t.started_at) >= before - 1000 && Date.parse(t.started_at) <= Date.now() + 1000, 'started_at is the server time');
    const [row] = await env.ds.query('SELECT * FROM transactions WHERE transaction_id = $1', [t.transaction_id]);
    assert.equal(row.standard_id, env.core.state.services.get(SERVICE_A).standards[0].standard_id);
    assert.equal(row.version, 1);
    const asOf = env.core.callsTo('GET', '/standard')[0];
    assert.equal(asOf.headers['x-service-key'], 'test-service-key-0123456789');
    assert.equal(asOf.query.asOf, new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
  });

  it('the snapshot never changes when the Charter changes later (B4)', async () => {
    const t = (await start()).body;
    const svc = env.core.state.services.get(SERVICE_A);
    svc.standards = [{ from: '2025-01-01', to: null, standard_id: randomUUID(), days: 1, hours: 2, minutes: 3 }];
    svc.service_name = 'Renamed Service';
    svc.office_code = 'PUP-NEW';
    const again = await call(getTransactionRoute, req('GET', `/transactions/${t.transaction_id}`, { token: tokens.officeStaffA }), ctx(t.transaction_id));
    assert.deepEqual([again.body.standard_duration_days, again.body.standard_duration_hours, again.body.standard_duration_minutes], [3, 0, 0]);
    assert.equal(again.body.service_name, 'Transcript of Records');
    assert.equal(again.body.office_code, 'PUP-OSAS');
    assert.equal(again.body.tracking_no, t.tracking_no);
    seedCoreServices(env.core);
  });

  it('AC2: the tracking number follows OFFICE-YYYYMMDD-SEQ, 4 digits, and every one is unique', async () => {
    const first = await start();
    assert.match(first.body.tracking_no, /^PUP-OSAS-\d{8}-0001$/);
    assert.equal(first.body.tracking_no, `PUP-OSAS-${manilaDay()}-0001`);
    await env.ds.query(`UPDATE transactions SET status = 'CANCELLED', cancel_reason = 'next', hold_started_at = NULL`);
    assert.equal((await start()).body.tracking_no, `PUP-OSAS-${manilaDay()}-0002`);
    const other = await start({ service_id: SERVICE_B }, tokens.officeStaffB);
    assert.equal(other.body.tracking_no, `PUP-ACAD-${manilaDay()}-0001`, 'each office has its own sequence');
    const unique = await env.ds.query('SELECT tracking_no FROM transactions GROUP BY tracking_no HAVING count(*) > 1');
    assert.equal(unique.length, 0);
    await assert.rejects(env.ds.query(`UPDATE transactions SET tracking_no = 'X' WHERE tracking_no LIKE 'PUP-OSAS%'`).then(() => env.ds.query(`UPDATE transactions SET tracking_no = 'X'`)), /transactions_tracking_no_uq/);
  });

  it('the sequence restarts each Manila date: 23:59:59 on one day and 00:00:00 on the next', async () => {
    const deps = (iso) => ({ core: createCoreClient(), now: () => new Date(iso) });
    const late = await startTransaction(env.ds, deps('2026-11-10T15:59:59Z'), staffA, body()); // 23:59:59 Manila on 11/10
    assert.equal(late.tracking_no, 'PUP-OSAS-20261110-0001');
    assert.equal(env.core.callsTo('GET', '/standard').at(-1).query.asOf, '2026-11-10');
    await env.ds.query(`UPDATE transactions SET status = 'CANCELLED', cancel_reason = 'next', hold_started_at = NULL`);
    const next = await startTransaction(env.ds, deps('2026-11-10T16:00:00Z'), staffA, body()); // 00:00:00 Manila on 11/11
    assert.equal(next.tracking_no, 'PUP-OSAS-20261111-0001');
    assert.equal(env.core.callsTo('GET', '/standard').at(-1).query.asOf, '2026-11-11');
  });

  it('AC3: client type is required; reference and email are optional; a bad email is rejected', async () => {
    for (const client_type of [undefined, '', 'CITIZEN', 'student', null]) {
      const r = await start({ client_type });
      assert.equal(r.status, 400, String(client_type));
      assert.equal(r.body.error.details.client_type, 'Client type is required');
    }
    for (const client_email of ['not-an-email', 'a@b', 'a b@c.d', 'x'.repeat(250) + '@a.bc', 12]) {
      const r = await start({ client_email });
      assert.equal(r.status, 400, String(client_email));
      assert.equal(r.body.error.details.client_email, 'Enter a valid email address');
    }
    const long = await start({ client_reference: 'x'.repeat(101) });
    assert.equal(long.status, 400);
    assert.ok(long.body.error.details.client_reference);
    assert.equal(await rowCount(), 0);
    const bare = await start({ client_reference: undefined, client_email: undefined, client_type: 'EXTERNAL' });
    assert.equal(bare.status, 201);
    assert.equal(bare.body.client_email, null);
    assert.equal(bare.body.client_reference, null);
    assert.equal(bare.body.client_type, 'EXTERNAL');
  });

  it('AC4: if Catalogue is unreachable after one retry, the start is blocked with a clear message and nothing is saved', async () => {
    env.core.setMode('down');
    const r = await start();
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'CATALOGUE_UNAVAILABLE');
    assert.equal(r.body.error.message, 'Cannot reach the service catalogue right now. Try again, or record the transaction later as a backdated entry.');
    assert.equal(env.core.callsTo('GET', '/standard').length, 2, 'one try and one retry');
    assert.equal(await rowCount(), 0);
    assert.equal(await lastSeq(), 0, 'no tracking number was consumed');
    assert.equal((await audits('TRANSACTION_STARTED')).length, 0);
    env.core.reset();
    env.core.setMode('drop');
    assert.equal((await start()).status, 503, 'a dropped connection is retried once, then blocked');
    env.core.reset();
  });

  it('AC4: one failure is retried and the start then succeeds', async () => {
    env.core.failNext(1);
    const r = await start();
    assert.equal(r.status, 201);
    assert.equal(env.core.callsTo('GET', '/standard').length, 2);
  });

  it('AC5: Start is refused unless all mandatory documents are confirmed; Core is not even asked', async () => {
    for (const requirements_confirmed of [false, undefined, 'true', 1, null]) {
      const r = await start({ requirements_confirmed });
      assert.equal(r.status, 400, String(requirements_confirmed));
      assert.equal(r.body.error.details.requirements_confirmed, 'Confirm that all required documents are present before starting');
    }
    assert.equal(env.core.callsTo('GET', '/standard').length, 0);
    assert.equal(await rowCount(), 0);
  });

  it('AC6: a second open transaction for the same staff is refused, and a failed start does not use a tracking number', async () => {
    assert.equal((await start()).status, 201);
    const second = await start();
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'OPEN_TRANSACTION_EXISTS');
    assert.equal(second.body.error.message, 'You already have an open transaction. Complete or hand it over first.');
    assert.equal(await rowCount(), 1);
    assert.equal(await lastSeq(), 1, 'the sequence number of the failed start was rolled back');
    await env.ds.query(`UPDATE transactions SET status = 'ON_HOLD', hold_started_at = now()`);
    assert.equal((await start()).status, 409, 'an ON_HOLD transaction still counts as open');
    await env.ds.query(`UPDATE transactions SET status = 'COMPLETED', hold_started_at = NULL, ended_at = now()`);
    assert.equal((await start()).status, 201, 'once it is closed, staff can start another');
  });

  it('AC6: two parallel starts by the same staff give one 201 and one 409 (the unique index decides)', async () => {
    const results = await Promise.all([start(), start()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await rowCount(), 1);
    assert.equal(await lastSeq(), 1);
  });

  it('parallel starts by different staff all succeed with different tracking numbers', async () => {
    const results = await Promise.all([start({}, tokens.officeStaffA), start({}, tokens.officeStaffA2), start({}, tokens.officeHeadA)]);
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
    assert.deepEqual(results.map((r) => r.body.tracking_no.slice(-4)).sort(), ['0001', '0002', '0003']);
  });

  it('AC7: an inactive service, an unknown service, or a service with no standard in force is refused', async () => {
    env.core.state.services.get(SERVICE_A).is_active = false;
    const inactive = await start();
    assert.equal(inactive.status, 409);
    assert.equal(inactive.body.error.code, 'SERVICE_INACTIVE');
    assert.equal(inactive.body.error.message, 'Service inactive');
    env.core.state.services.get(SERVICE_A).is_active = true;
    const unknown = await start({ service_id: randomUUID() });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'SERVICE_NOT_FOUND');
    env.core.state.services.get(SERVICE_A).standards = [{ from: '2999-01-01', to: null, standard_id: randomUUID(), days: 1, hours: 0, minutes: 0 }];
    const none = await start();
    assert.equal(none.status, 409);
    assert.equal(none.body.error.code, 'STANDARD_NOT_IN_FORCE');
    assert.equal(none.body.error.message, 'No standard is in force for this service today');
    for (const service_id of [undefined, 'nope', '']) assert.equal((await start({ service_id })).status, 400);
    assert.equal(await rowCount(), 0);
    seedCoreServices(env.core);
  });

  it('AC8: Office Staff and Office Head cannot start for another office\'s service (403) and nothing is saved; Executive gets 403', async () => {
    for (const token of [tokens.officeStaffA, tokens.officeHeadA]) {
      const r = await start({ service_id: SERVICE_B }, token);
      assert.equal(r.status, 403);
    }
    assert.equal((await start({}, tokens.executive)).status, 403);
    assert.equal(await rowCount(), 0);
    assert.equal(await lastSeq(), 0);
    assert.equal((await start({ service_id: SERVICE_B }, tokens.superAdmin)).status, 201, 'Super Admin may start for any office');
    assert.equal((await call(startRoute, req('POST', '/transactions', { body: body() }))).status, 401);
  });

  it('AC9: the start is audited without the citizen\'s email or reference', async () => {
    const t = (await start()).body;
    const rows = await audits('TRANSACTION_STARTED');
    assert.equal(rows.length, 1);
    const event = rows[0].payload;
    assert.equal(event.entity_type, 'transaction');
    assert.equal(event.entity_id, t.transaction_id);
    assert.equal(event.office_id, OFFICE_A);
    assert.equal(event.actor_user_id, USERS.staffA);
    assert.equal(event.after_value.tracking_no, t.tracking_no);
    assert.equal(event.after_value.service_code, 'PUP-OSAS-TOR-001');
    assert.equal(event.after_value.client_type, 'STUDENT');
    assert.equal(event.after_value.requirements_confirmed, true);
    assert.equal(event.after_value.standard_duration_days, 3);
    assert.equal(event.after_value.counter_id, null);
    const text = JSON.stringify(event);
    assert.ok(!text.includes('juan@example.com') && !text.includes('2023-00123-QC-0'));
  });
});

describe('counters on (B22)', () => {
  let counterA;
  let counterA2;
  beforeEach(async () => {
    await env.ds.query('UPDATE transaction_settings SET counters_enabled = true');
    counterA = randomUUID();
    counterA2 = randomUUID();
    await env.ds.query(`INSERT INTO counters (counter_id, office_id, label) VALUES ($1, $2, 'Window 1'), ($3, $2, 'Window 2')`, [counterA, OFFICE_A, counterA2]);
  });

  it('a counter of the service\'s office is required ("Choose your counter") and is saved on the transaction', async () => {
    const missing = await start();
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details.counter_id, 'Choose your counter');
    const ok = await start({ counter_id: counterA });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.counter_id, counterA);
    assert.equal(ok.body.counter_label, 'Window 1');
    assert.equal((await audits('TRANSACTION_STARTED'))[0].payload.after_value.counter_id, counterA);
  });

  it('a counter of another office, an inactive counter, an unknown counter or a malformed id is refused', async () => {
    const other = randomUUID();
    await env.ds.query(`INSERT INTO counters (counter_id, office_id, label) VALUES ($1, $2, 'Window X')`, [other, OFFICE_B]);
    await env.ds.query('UPDATE counters SET is_active = false WHERE counter_id = $1', [counterA2]);
    for (const counter_id of [other, counterA2, randomUUID(), 'nope']) {
      const r = await start({ counter_id });
      assert.equal(r.status, 400, String(counter_id));
      assert.equal(r.body.error.details.counter_id, 'Choose your counter');
    }
    assert.equal(await rowCount(), 0);
    assert.equal(await lastSeq(), 0);
  });

  it('AC6: a second open transaction on the same counter is refused, whoever starts it; other counters are free', async () => {
    assert.equal((await start({ counter_id: counterA })).status, 201);
    const busy = await start({ counter_id: counterA }, tokens.officeStaffA2);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'COUNTER_BUSY');
    assert.equal(busy.body.error.message, 'This counter already has an open transaction');
    assert.equal(await lastSeq(), 1, 'the failed start used no tracking number');
    assert.equal((await start({ counter_id: counterA2 }, tokens.officeStaffA2)).status, 201);
  });

  it('with counters off the counter is ignored', async () => {
    await env.ds.query('UPDATE transaction_settings SET counters_enabled = false');
    const r = await start({ counter_id: counterA });
    assert.equal(r.status, 201);
    assert.equal(r.body.counter_id, null);
  });

  it('turning counters off or on never changes transactions already recorded (AC7 of TT5)', async () => {
    const t = (await start({ counter_id: counterA })).body;
    await env.ds.query('UPDATE transaction_settings SET counters_enabled = false');
    const [row] = await env.ds.query('SELECT counter_id, status FROM transactions WHERE transaction_id = $1', [t.transaction_id]);
    assert.equal(row.counter_id, counterA);
    assert.equal(row.status, 'IN_PROGRESS');
  });
});

runBoundarySuite({
  name: 'operations start',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'POST /transactions',
      write: true,
      superAdminOnly: false,
      officeScoped: true,
      invoke: async (token, target) => {
        await env.ds.query(`UPDATE transactions SET status = 'CANCELLED', cancel_reason = 'boundary', hold_started_at = NULL WHERE status IN ('IN_PROGRESS', 'ON_HOLD')`);
        const r = await start({ service_id: target === 'own' ? SERVICE_A : SERVICE_B }, token);
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    },
  ],
});
