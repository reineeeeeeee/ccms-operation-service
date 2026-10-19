// TT5: counters - per office, never deleted, only deactivated; the office is checked in Core.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { GET as listRoute, POST as postRoute } from '../src/app/api/counters/route.js';
import { PUT as putRoute } from '../src/app/api/counters/[id]/route.js';
import { PATCH as deactivate } from '../src/app/api/counters/[id]/deactivate/route.js';
import { PATCH as reactivate } from '../src/app/api/counters/[id]/reactivate/route.js';
import { OFFICE_A, OFFICE_B, USERS, call, ctx, req, resetData, setupTestEnv, tokens } from './helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
  await resetData(env.ds);
});
after(async () => env?.teardown());

const add = (body, token = tokens.superAdmin) => call(postRoute, req('POST', '/counters', { token, body }));
const list = (query = '', token = tokens.superAdmin) => call(listRoute, req('GET', `/counters${query}`, { token }));
const rename = (id, body, token = tokens.superAdmin) => call(putRoute, req('PUT', `/counters/${id}`, { token, body }), ctx(id));
const audits = (action) => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = $1 ORDER BY created_at`, [action]);

describe('counters (TT5-T3)', () => {
  it('AC6: a counter is added to an office; the label is unique per office in any letter case', async () => {
    const a = await add({ office_id: OFFICE_A, label: 'Window 1' });
    assert.equal(a.status, 201);
    assert.deepEqual(Object.keys(a.body).sort(), ['counter_id', 'is_active', 'label', 'office_id']);
    assert.equal(a.body.is_active, true);
    const dup = await add({ office_id: OFFICE_A, label: '  WINDOW 1 ' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.message, 'This office already has a counter with this label');
    assert.equal((await add({ office_id: OFFICE_B, label: 'Window 1' })).status, 201, 'another office may use the same label');
    const created = (await audits('COUNTER_CREATED')).map((r) => r.payload);
    assert.equal(created.length, 2);
    assert.equal(created[0].office_id, OFFICE_A);
    assert.equal(created[0].entity_type, 'counter');
    assert.equal(created[0].after_value.label, 'Window 1');
    assert.equal(created[0].before_value, null);
  });

  it('validates the label (1-50 characters) and the office', async () => {
    for (const label of ['', '   ', 'x'.repeat(51), undefined, 12]) {
      const r = await add({ office_id: OFFICE_A, label });
      assert.equal(r.status, 400, String(label));
      assert.ok(r.body.error.details.label);
    }
    assert.equal((await add({ office_id: OFFICE_A, label: 'x'.repeat(50) })).status, 201);
    const noOffice = await add({ label: 'Window 9' });
    assert.equal(noOffice.status, 400);
    assert.ok(noOffice.body.error.details.office_id);
  });

  it('the office must exist and be active in Core (409 "Office not found or inactive"); Core down is a 503', async () => {
    const unknown = await add({ office_id: randomUUID(), label: 'Window 2' });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error.message, 'Office not found or inactive');
    const inactive = randomUUID();
    env.core.addOffice({ office_id: inactive, office_code: 'PUP-OLD', is_active: false });
    assert.equal((await add({ office_id: inactive, label: 'Window 2' })).status, 409);
    env.core.setMode('down');
    try {
      const down = await add({ office_id: OFFICE_A, label: 'Window 2' });
      assert.equal(down.status, 503);
      assert.equal(down.body.error.code, 'CATALOGUE_UNAVAILABLE');
    } finally {
      env.core.reset();
    }
    assert.equal((await env.ds.query(`SELECT 1 FROM counters WHERE label = 'Window 2'`)).length, 0, 'nothing saved on any failure');
  });

  it('GET: Super Admin sees every office or one; Office Head and Staff only their own; another office is 403; Executive is refused', async () => {
    assert.equal((await list()).body.items.length, 3);
    assert.equal((await list(`?officeId=${OFFICE_B}`)).body.items.length, 1);
    const own = await list('', tokens.officeStaffA);
    assert.equal(own.status, 200);
    assert.ok(own.body.items.length >= 2 && own.body.items.every((c) => c.office_id === OFFICE_A));
    assert.equal((await list(`?officeId=${OFFICE_A}`, tokens.officeHeadA)).status, 200);
    const other = await list(`?officeId=${OFFICE_B}`, tokens.officeHeadA);
    assert.equal(other.status, 403);
    assert.ok(!JSON.stringify(other.body).includes('Window'), 'no data leaks in the 403');
    assert.equal((await list('', tokens.executive)).status, 403);
    assert.equal((await list('?officeId=nope')).status, 400);
    assert.equal((await call(listRoute, req('GET', '/counters'))).status, 401);
  });

  it('edit: rename (audited), reject a clash, no-op when nothing changes', async () => {
    const c = (await add({ office_id: OFFICE_A, label: 'Window 7' })).body;
    const renamed = await rename(c.counter_id, { office_id: OFFICE_A, label: 'Window Seven' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.label, 'Window Seven');
    const [update] = (await audits('COUNTER_UPDATED')).map((r) => r.payload).slice(-1);
    assert.equal(update.before_value.label, 'Window 7');
    assert.equal(update.after_value.label, 'Window Seven');
    const clash = await rename(c.counter_id, { office_id: OFFICE_A, label: 'window 1' });
    assert.equal(clash.status, 409);
    const count = (await audits('COUNTER_UPDATED')).length;
    assert.equal((await rename(c.counter_id, { office_id: OFFICE_A, label: 'Window Seven' })).status, 200);
    assert.equal((await audits('COUNTER_UPDATED')).length, count);
    assert.equal((await rename(randomUUID(), { office_id: OFFICE_A, label: 'x' })).status, 404);
  });

  it('deactivate and reactivate: the row stays (never deleted); doing it twice is a no-op; audited', async () => {
    const c = (await add({ office_id: OFFICE_A, label: 'Window 8' })).body;
    const off = await call(deactivate, req('PATCH', `/counters/${c.counter_id}/deactivate`, { token: tokens.superAdmin }), ctx(c.counter_id));
    assert.equal(off.status, 200);
    assert.equal(off.body.is_active, false);
    await call(deactivate, req('PATCH', `/counters/${c.counter_id}/deactivate`, { token: tokens.superAdmin }), ctx(c.counter_id));
    assert.equal((await audits('COUNTER_DEACTIVATED')).length, 1);
    assert.equal((await list(`?officeId=${OFFICE_A}`)).body.items.find((x) => x.counter_id === c.counter_id).is_active, false);
    const on = await call(reactivate, req('PATCH', `/counters/${c.counter_id}/reactivate`, { token: tokens.superAdmin }), ctx(c.counter_id));
    assert.equal(on.body.is_active, true);
    assert.equal((await audits('COUNTER_REACTIVATED')).length, 1);
  });

  it('a counter with an open transaction cannot be renamed, moved or deactivated (409), and works again once it is free', async () => {
    const c = (await add({ office_id: OFFICE_A, label: 'Window Busy' })).body;
    await env.ds.query(
      `INSERT INTO transactions (transaction_id, tracking_no, service_id, service_code, service_name, office_id, office_code, service_classification, standard_id,
         standard_duration_days, standard_duration_hours, standard_duration_minutes, counter_id, client_type, started_at, started_by, status)
       VALUES ($1, 'PUP-OSAS-20261010-0099', $2, 'S-1', 'Service', $3, 'PUP-OSAS', 'SIMPLE', $4, 1, 0, 0, $5, 'STUDENT', now(), $6, 'IN_PROGRESS')`,
      [randomUUID(), randomUUID(), OFFICE_A, randomUUID(), c.counter_id, USERS.staffA],
    );
    const busy = 'This counter has an open transaction';
    const edit = await rename(c.counter_id, { office_id: OFFICE_A, label: 'Window Busy 2' });
    assert.equal(edit.status, 409);
    assert.equal(edit.body.error.message, busy);
    assert.equal((await rename(c.counter_id, { office_id: OFFICE_B, label: 'Window Busy' })).status, 409);
    const off = await call(deactivate, req('PATCH', `/counters/${c.counter_id}/deactivate`, { token: tokens.superAdmin }), ctx(c.counter_id));
    assert.equal(off.status, 409);
    await env.ds.query(`UPDATE transactions SET status = 'CANCELLED', cancel_reason = 'x', hold_started_at = NULL WHERE counter_id = $1`, [c.counter_id]);
    assert.equal((await rename(c.counter_id, { office_id: OFFICE_A, label: 'Window Busy 2' })).status, 200);
    await env.ds.query('DELETE FROM transactions');
  });

  it('moving a counter to another office checks that office in Core', async () => {
    const c = (await add({ office_id: OFFICE_A, label: 'Window Move' })).body;
    const moved = await rename(c.counter_id, { office_id: OFFICE_B, label: 'Window Move' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.office_id, OFFICE_B);
    assert.equal((await rename(c.counter_id, { office_id: randomUUID(), label: 'Window Move' })).status, 409);
  });
});

runBoundarySuite({
  name: 'operations counters',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'POST /counters',
      write: true,
      superAdminOnly: true,
      officeScoped: false,
      invoke: (token) => add({ office_id: OFFICE_A, label: `Boundary ${randomUUID()}` }, token).then((r) => new Response(JSON.stringify(r.body), { status: r.status })),
    },
    {
      name: 'GET /counters',
      write: false,
      superAdminOnly: false,
      officeScoped: true,
      invoke: (token, target) => list(`?officeId=${target === 'own' ? OFFICE_A : OFFICE_B}`, token).then((r) => new Response(JSON.stringify(r.body), { status: r.status })),
    },
  ],
});
