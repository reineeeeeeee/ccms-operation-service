// CC027: role-scoped list and detail (BR-TXN-009).
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { GET as detailRoute } from '../src/app/api/transactions/[id]/route.js';
import { GET as listRoute } from '../src/app/api/transactions/route.js';
import { OFFICE_A, OFFICE_B, SERVICE_B, USERS, at, call, ctx, insertTransaction, req, resetData, setupTestEnv, tokens } from './helpers.js';

let env;
const rows = {};
before(async () => {
  env = await setupTestEnv();
  await resetData(env.ds);
  const base = new Date(at('2026-10-06', '09:00')).getTime();
  const t = (i) => new Date(base + i * 3_600_000);
  rows.a1 = await insertTransaction(env.ds, { tracking_no: 'PUP-OSAS-20261006-0001', started_by: USERS.staffA, started_at: t(0), client_email: 'a1@example.com', client_reference: 'REF-A1', status: 'COMPLETED', ended_at: t(1), elapsed_working_minutes: 60, is_compliant: true, variance_minutes: -5 });
  rows.a2 = await insertTransaction(env.ds, { tracking_no: 'PUP-OSAS-20261006-0002', started_by: USERS.staffA2, started_at: t(2), client_type: 'ALUMNI' });
  rows.a3 = await insertTransaction(env.ds, { tracking_no: 'PUP-OSAS-20261007-0001', started_by: USERS.staffA, started_at: t(24), status: 'CANCELLED', cancel_reason: 'x' });
  rows.b1 = await insertTransaction(env.ds, { tracking_no: 'PUP-ACAD-20261006-0001', office_id: OFFICE_B, office_code: 'PUP-ACAD', service_id: SERVICE_B, started_by: USERS.staffB, started_at: t(3), client_email: 'b1@example.com' });
});
after(async () => env?.teardown());

const list = (query = '', token = tokens.superAdmin) => call(listRoute, req('GET', `/transactions${query}`, { token }));
const detail = (id, token = tokens.superAdmin) => call(detailRoute, req('GET', `/transactions/${id}`, { token }), ctx(id));
const trackingOf = (r) => r.body.items.map((i) => i.tracking_no);

describe('CC027 list', () => {
  it('AC1: Super Admin sees all offices, Office Head their office, Office Staff their own records; Executive none (403)', async () => {
    assert.deepEqual(trackingOf(await list()).sort(), ['PUP-ACAD-20261006-0001', 'PUP-OSAS-20261006-0001', 'PUP-OSAS-20261006-0002', 'PUP-OSAS-20261007-0001']);
    assert.deepEqual(trackingOf(await list('', tokens.officeHeadA)).sort(), ['PUP-OSAS-20261006-0001', 'PUP-OSAS-20261006-0002', 'PUP-OSAS-20261007-0001']);
    assert.deepEqual(trackingOf(await list('', tokens.officeStaffA)).sort(), ['PUP-OSAS-20261006-0001', 'PUP-OSAS-20261007-0001']);
    assert.deepEqual(trackingOf(await list('', tokens.officeStaffA2)), ['PUP-OSAS-20261006-0002']);
    assert.deepEqual(trackingOf(await list('', tokens.officeHeadB)), ['PUP-ACAD-20261006-0001']);
    assert.equal((await list('', tokens.executive)).status, 403);
    assert.equal((await call(listRoute, req('GET', '/transactions'))).status, 401);
  });

  it('newest first, with the page shape of GET /services', async () => {
    const r = await list('?page=1&page_size=2');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['items', 'page', 'page_size', 'total']);
    assert.equal(r.body.total, 4);
    assert.equal(r.body.page_size, 2);
    assert.deepEqual(trackingOf(r), ['PUP-OSAS-20261007-0001', 'PUP-ACAD-20261006-0001']);
    assert.deepEqual(trackingOf(await list('?page=2&page_size=2')), ['PUP-OSAS-20261006-0002', 'PUP-OSAS-20261006-0001']);
    for (const bad of ['?page=0', '?page=x', '?page_size=101', '?page_size=0']) assert.equal((await list(bad)).status, 400, bad);
  });

  it('AC2: filters narrow the list: status, service, counter, office (Super Admin), dates (Manila), tracking number or its start', async () => {
    assert.deepEqual(trackingOf(await list('?status=CANCELLED')), ['PUP-OSAS-20261007-0001']);
    assert.deepEqual(trackingOf(await list(`?service_id=${SERVICE_B}`)), ['PUP-ACAD-20261006-0001']);
    assert.deepEqual(trackingOf(await list(`?office_id=${OFFICE_B}`)), ['PUP-ACAD-20261006-0001']);
    assert.deepEqual(trackingOf(await list('?from=2026-10-07&to=2026-10-07')), ['PUP-OSAS-20261007-0001']);
    assert.equal((await list('?from=2026-10-08')).body.total, 0);
    assert.equal((await list('?to=2026-10-05')).body.total, 0);
    assert.deepEqual(trackingOf(await list('?q=PUP-OSAS-20261006')).sort(), ['PUP-OSAS-20261006-0001', 'PUP-OSAS-20261006-0002']);
    assert.deepEqual(trackingOf(await list('?q=pup-osas-20261007-0001')), ['PUP-OSAS-20261007-0001'], 'case does not matter');
    assert.equal((await list('?q=0001')).body.total, 0, 'a prefix, not a fragment');
    assert.equal((await list('?q=%25')).body.total, 0, '% is not a wildcard');
    const counter = randomUUID();
    await env.ds.query(`INSERT INTO counters (counter_id, office_id, label) VALUES ($1, $2, 'Window 3')`, [counter, OFFICE_A]);
    await env.ds.query('UPDATE transactions SET counter_id = $1 WHERE transaction_id = $2', [counter, rows.a2.transaction_id]);
    const byCounter = await list(`?counter_id=${counter}`);
    assert.deepEqual(trackingOf(byCounter), ['PUP-OSAS-20261006-0002']);
    assert.equal(byCounter.body.items[0].counter_label, 'Window 3');
  });

  it('a Manila day runs from 00:00 to 23:59:59 Manila time', async () => {
    const late = await insertTransaction(env.ds, { tracking_no: 'PUP-OSAS-20261020-0001', started_at: new Date(at('2026-10-20', '23:59')) });
    const early = await insertTransaction(env.ds, { tracking_no: 'PUP-OSAS-20261021-0001', started_at: new Date(at('2026-10-21', '00:00')) });
    assert.deepEqual(trackingOf(await list('?from=2026-10-20&to=2026-10-20')), ['PUP-OSAS-20261020-0001']);
    assert.deepEqual(trackingOf(await list('?from=2026-10-21&to=2026-10-21')), ['PUP-OSAS-20261021-0001']);
    await env.ds.query('DELETE FROM transactions WHERE transaction_id = ANY($1)', [[late.transaction_id, early.transaction_id]]);
  });

  it('bad filters are 400 with a field detail', async () => {
    const cases = [['?status=NOPE', 'status'], ['?service_id=x', 'service_id'], ['?counter_id=x', 'counter_id'], ['?office_id=x', 'office_id'], ['?from=10/06/2026', 'from'], ['?to=2026-13-01', 'to'], ['?from=2026-10-09&to=2026-10-01', 'from'], [`?q=${'x'.repeat(61)}`, 'q']];
    for (const [query, field] of cases) {
      const r = await list(query);
      assert.equal(r.status, 400, query);
      assert.ok(r.body.error.details[field], query);
    }
  });

  it('only Super Admin filters by another office; others get 403 for another office and nothing leaks', async () => {
    const r = await list(`?office_id=${OFFICE_B}`, tokens.officeHeadA);
    assert.equal(r.status, 403);
    assert.ok(!JSON.stringify(r.body).includes('PUP-ACAD'));
    assert.equal((await list(`?office_id=${OFFICE_B}`, tokens.officeStaffA)).status, 403);
    assert.equal((await list(`?office_id=${OFFICE_A}`, tokens.officeHeadA)).status, 200);
  });

  it('the list shows the result and who started it, but never the client email or reference', async () => {
    const r = await list('?q=PUP-OSAS-20261006-0001');
    const item = r.body.items[0];
    assert.equal(item.is_compliant, true);
    assert.equal(item.elapsed_working_minutes, 60);
    assert.equal(item.variance_minutes, -5);
    assert.equal(item.started_by, USERS.staffA);
    assert.equal(item.client_type, 'STUDENT');
    for (const key of ['client_email', 'client_reference', 'cancel_reason', 'hold_reason', 'backdate_reason']) assert.ok(!(key in item), key);
    assert.ok(!JSON.stringify(r.body).includes('a1@example.com'));
  });
});

describe('CC027 detail', () => {
  it('AC1: the detail carries the client email and reference; every date is an ISO instant', async () => {
    const r = await detail(rows.a1.transaction_id, tokens.officeStaffA);
    assert.equal(r.status, 200);
    assert.equal(r.body.client_email, 'a1@example.com');
    assert.equal(r.body.client_reference, 'REF-A1');
    assert.equal(r.body.tracking_no, 'PUP-OSAS-20261006-0001');
    assert.equal(r.body.started_at, '2026-10-06T01:00:00.000Z');
    assert.equal(r.body.ended_at, '2026-10-06T02:00:00.000Z');
    assert.equal(r.body.standard_duration_days, 3);
  });

  it('AC3: a transaction outside the user\'s scope is a 403 with no data; unknown is 404', async () => {
    for (const token of [tokens.officeStaffA2, tokens.officeHeadB, tokens.officeStaffB, tokens.executive]) {
      const r = await detail(rows.a1.transaction_id, token);
      assert.equal(r.status, 403, 'a1');
      assert.ok(!JSON.stringify(r.body).includes('PUP-OSAS') && !JSON.stringify(r.body).includes('a1@example.com'));
    }
    assert.equal((await detail(rows.a1.transaction_id, tokens.officeHeadA)).status, 200);
    assert.equal((await detail(rows.a1.transaction_id, tokens.superAdmin)).status, 200);
    assert.equal((await detail(randomUUID())).status, 404);
    assert.equal((await detail('nope')).status, 404);
    assert.equal((await call(detailRoute, req('GET', '/transactions/x'), ctx(rows.a1.transaction_id))).status, 401);
  });

  it('Office Staff moved to another office still see the transactions they started (started_by)', async () => {
    const moved = await env.keys.signToken({ sub: USERS.staffA, role: 'office_staff', office_id: OFFICE_B });
    const own = await detail(rows.a1.transaction_id, moved);
    assert.equal(own.status, 200);
    assert.equal((await detail(rows.a2.transaction_id, moved)).status, 403);
    assert.deepEqual(trackingOf(await list('', moved)).sort(), ['PUP-OSAS-20261006-0001', 'PUP-OSAS-20261007-0001']);
  });
});

runBoundarySuite({
  name: 'operations list and detail',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'GET /transactions/:id',
      write: false,
      superAdminOnly: false,
      officeScoped: true,
      otherOfficeMarker: 'PUP-ACAD-20261006-0001',
      invoke: async (token, target) => {
        const id = target === 'own' ? rows.a1.transaction_id : rows.b1.transaction_id;
        const r = await detail(id, token);
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    },
    {
      name: 'GET /transactions?office_id=',
      write: false,
      superAdminOnly: false,
      officeScoped: true,
      otherOfficeMarker: 'PUP-ACAD-20261006-0001',
      invoke: async (token, target) => {
        const r = await list(`?office_id=${target === 'own' ? OFFICE_A : OFFICE_B}`, token);
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    },
  ],
});
