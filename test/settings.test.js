// TT5: transaction settings (hold, counters, auto-close) - GET for every role, PUT for Super Admin with a version check.
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { runBoundarySuite } from 'ccms-shared/testing';
import { GET as getSettings, PUT as putSettings } from '../src/app/api/settings/route.js';
import { DEFAULT_SETTINGS_SQL, afterSync } from '../src/lib/after-sync.js';
import { call, req, resetData, setupTestEnv, tokens } from './helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
});
after(async () => env?.teardown());

const read = (token = tokens.superAdmin) => call(getSettings, req('GET', '/settings', { token }));
const save = (body, token = tokens.superAdmin) => call(putSettings, req('PUT', '/settings', { token, body }));
const full = (over = {}) => ({
  hold_enabled: false,
  counters_enabled: false,
  auto_close_days_simple: null,
  auto_close_days_complex: null,
  auto_close_days_highly_technical: null,
  version: 1,
  ...over,
});
const audits = () => env.ds.query(`SELECT payload FROM audit_outbox WHERE payload->>'action' = 'TRANSACTION_SETTINGS_UPDATED' ORDER BY created_at`);

describe('settings (TT5)', () => {
  before(() => resetData(env.ds));

  it('AC1: a new installation has hold off, counters off and auto-close off (all values empty)', async () => {
    const r = await read();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, full());
    assert.equal((await env.ds.query('SELECT count(*)::int AS n FROM transaction_settings'))[0].n, 1);
  });

  it('AC3: every signed-in role reads them; no token is a 401', async () => {
    for (const token of Object.values(tokens)) assert.equal((await read(token)).status, 200);
    assert.equal((await call(getSettings, req('GET', '/settings'))).status, 401);
  });

  it('AC3: Office Head, Office Staff and Executive get 403 on any change', async () => {
    for (const token of [tokens.officeHeadA, tokens.officeStaffA, tokens.executive]) assert.equal((await save(full(), token)).status, 403);
  });

  it('AC2: Super Admin saves new values; the version goes up; the change is audited with before and after (no office)', async () => {
    const r = await save(full({ hold_enabled: true, counters_enabled: true, auto_close_days_simple: 5, auto_close_days_complex: '10', auto_close_days_highly_technical: null }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, full({ hold_enabled: true, counters_enabled: true, auto_close_days_simple: 5, auto_close_days_complex: 10, version: 2 }));
    assert.deepEqual((await read(tokens.executive)).body, r.body);
    const rows = await audits();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.office_id, null);
    assert.equal(rows[0].payload.entity_type, 'transaction_settings');
    assert.equal(rows[0].payload.before_value.hold_enabled, false);
    assert.equal(rows[0].payload.after_value.hold_enabled, true);
    assert.equal(rows[0].payload.after_value.version, 2);
  });

  it('AC4: two Super Admins saving from the same old version: the second gets 409 and nothing is overwritten', async () => {
    const first = await save(full({ version: 2, hold_enabled: true, counters_enabled: true, auto_close_days_simple: 7 }));
    assert.equal(first.status, 200);
    const second = await save(full({ version: 2, hold_enabled: false, counters_enabled: false }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'SETTINGS_VERSION_CONFLICT');
    assert.equal(second.body.error.message, 'Settings were changed by someone else. Reload and try again.');
    const now = (await read()).body;
    assert.equal(now.auto_close_days_simple, 7);
    assert.equal(now.hold_enabled, true);
    assert.equal(now.version, 3);
  });

  it('AC5: an auto-close value that is not a whole number from 1 to 365 is rejected naming the field', async () => {
    const version = (await read()).body.version;
    for (const [field, value] of [['auto_close_days_simple', 0], ['auto_close_days_complex', 366], ['auto_close_days_highly_technical', 1.5], ['auto_close_days_simple', -3], ['auto_close_days_complex', 'abc'], ['auto_close_days_simple', true]]) {
      const r = await save(full({ version, [field]: value }));
      assert.equal(r.status, 400, `${field}=${value}`);
      assert.equal(r.body.error.details[field], 'Enter a whole number of working days from 1 to 365, or leave empty to turn auto-close off');
    }
    for (const value of [1, 365, null, '']) assert.equal((await save(full({ version: (await read()).body.version, auto_close_days_simple: value }))).status, 200, String(value));
  });

  it('the switches must be true or false and the version must be sent', async () => {
    const version = (await read()).body.version;
    const r = await save({ hold_enabled: 'yes', counters_enabled: undefined, auto_close_days_simple: null, auto_close_days_complex: null, auto_close_days_highly_technical: null, version });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.details.hold_enabled && r.body.error.details.counters_enabled);
    const noVersion = await save({ ...full(), version: undefined });
    assert.equal(noVersion.status, 400);
    assert.ok(noVersion.body.error.details.version);
    const missing = await save({ hold_enabled: false, counters_enabled: false, version });
    assert.equal(missing.status, 400, 'the full settings are required');
    assert.ok(missing.body.error.details.auto_close_days_simple);
  });

  it('saving the values that are already stored changes nothing (no new version, no audit entry)', async () => {
    const current = (await read()).body;
    const before = (await audits()).length;
    const r = await save({ ...current });
    assert.equal(r.status, 200);
    assert.equal(r.body.version, current.version);
    assert.equal((await audits()).length, before);
  });

  it('the database keeps a single row with auto-close limits between 1 and 365 (CHECKs)', async () => {
    await assert.rejects(env.ds.query('INSERT INTO transaction_settings (id) VALUES (2)'), /transaction_settings_single_ck/);
    await assert.rejects(env.ds.query('UPDATE transaction_settings SET auto_close_days_simple = 400'), /auto_close_days_simple_ck/);
    await assert.rejects(env.ds.query('UPDATE transaction_settings SET auto_close_days_complex = 0'), /auto_close_days_complex_ck/);
  });

  it('after-sync recreates the default row if it is missing and never overwrites an existing one', async () => {
    const before = (await read()).body;
    await afterSync(env.ds);
    assert.deepEqual((await read()).body, before);
    await env.ds.query('DELETE FROM transaction_settings');
    await env.ds.query(DEFAULT_SETTINGS_SQL);
    assert.deepEqual((await read()).body, full());
  });
});

runBoundarySuite({
  name: 'transaction settings',
  describe,
  it,
  assert,
  tokens,
  endpoints: [
    {
      name: 'PUT /settings',
      write: true,
      superAdminOnly: true,
      officeScoped: false,
      invoke: async (token) => save(full({ version: 1_000_000 }), token).then((r) => new Response(JSON.stringify(r.body), { status: r.status === 409 ? 200 : r.status })),
    },
  ],
});
