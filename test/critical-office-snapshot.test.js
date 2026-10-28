import { strict as assert } from 'node:assert';
import { before, after, describe, it } from 'node:test';
import { setupTestEnv, seedCoreServices, req, call, ctx, tokens, SERVICE_A, OFFICE_A } from './helpers.js';
import { POST } from '../src/app/api/transactions/route.js';
import { GET as detail } from '../src/app/api/transactions/[id]/route.js';
import { GET as list } from '../src/app/api/transactions/route.js';
import { POST as complete } from '../src/app/api/transactions/[id]/complete/route.js';
import { buildReceipt } from '../src/modules/transaction/receipt.js';
import { migrateSprint4Operations } from '../src/lib/migrations/sprint4-critical.js';
let env;
before(async () => { env = await setupTestEnv(); seedCoreServices(env.core); });
after(async () => { await env?.teardown(); });
describe('F7 stable office-name snapshots', () => {
  it('copies the trusted office name, returns it everywhere, and never audits citizen fields', async () => {
    const result = await call(POST, req('POST', '/transactions', { token: tokens.officeStaffA, body: { service_id: SERVICE_A, client_type: 'STUDENT', requirements_confirmed: true, client_email: 'citizen@example.test', client_reference: 'TEST-REFERENCE' } }));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const id = result.body.transaction_id;
    assert.equal(result.body.office_name, 'Student Affairs');
    env.core.addOffice({ office_id: OFFICE_A, office_code: 'PUP-OSAS', office_name: 'Renamed Student Affairs' });
    const stored = (await call(detail, req('GET', `/transactions/${id}`, { token: tokens.officeStaffA }), ctx(id))).body;
    assert.equal(stored.office_name, 'Student Affairs');
    assert.equal((await call(list, req('GET', '/transactions', { token: tokens.officeStaffA }))).body.items[0].office_name, 'Student Affairs');
    const finished = await call(complete, req('POST', `/transactions/${id}/complete`, { token: tokens.officeStaffA }), ctx(id));
    assert.match(buildReceipt(finished.body).text, /Office: Student Affairs/);
    const audits = await env.ds.query('SELECT payload FROM audit_outbox');
    assert.ok(audits.every((r) => !JSON.stringify(r.payload).includes('citizen@example.test') && !JSON.stringify(r.payload).includes('TEST-REFERENCE')));
    assert.ok(audits.some((r) => r.payload.entity_name === result.body.tracking_no));
    await migrateSprint4Operations(env.ds); await migrateSprint4Operations(env.ds);
    assert.equal((await env.ds.query('SELECT office_name FROM transactions WHERE transaction_id=$1', [id]))[0].office_name, 'Student Affairs');
  });
  it('explains unavailable historical names without fabricating them from a code', () => {
    const content = buildReceipt({ tracking_no: 'PUP-OSAS-20261110-0001', office_code: 'PUP-OSAS', service_name: 'Example', started_at: new Date(), ended_at: new Date() }).text;
    assert.ok(content.includes('Office name unavailable (historical record)'));
    assert.ok(!content.includes('Office: PUP-OSAS'));
    assert.ok(content.includes('file a complaint'));
  });
});
