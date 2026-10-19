// CC021-T4: the Core client - service key, 5 second timeout, one retry on a network error, a timeout or a 5xx, and the mapping of answers.
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { CoreRejectedError, CoreUnavailableError, coreBaseUrl, createCoreClient } from '../src/modules/transaction/core-client.js';

const KEY = 'k-123';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const standard = { standard_id: 's1', duration_days: 1, duration_hours: 0, duration_minutes: 0, service_code: 'C', service_name: 'N', office_id: 'o', office_code: 'PUP-X', classification: 'SIMPLE' };

function client(fetchImpl, over = {}) {
  return createCoreClient({ baseUrl: 'http://core.test/api', serviceKey: KEY, fetchImpl, timeoutMs: 200, ...over });
}

describe('base URL', () => {
  it('works with or without the trailing /api, and is null when not configured', () => {
    assert.equal(coreBaseUrl({ CORE_URL: 'http://127.0.0.1:3003' }), 'http://127.0.0.1:3003/api');
    assert.equal(coreBaseUrl({ CORE_URL: 'http://127.0.0.1:3003/' }), 'http://127.0.0.1:3003/api');
    assert.equal(coreBaseUrl({ CORE_URL: 'http://127.0.0.1:3003/api' }), 'http://127.0.0.1:3003/api');
    assert.equal(coreBaseUrl({ CORE_URL: 'http://127.0.0.1:3003/api/' }), 'http://127.0.0.1:3003/api');
    assert.equal(coreBaseUrl({}), null);
    assert.equal(coreBaseUrl({ CORE_URL: '  ' }), null);
  });

  it('without CORE_URL every call fails as unavailable', async () => {
    await assert.rejects(createCoreClient({ baseUrl: null }).standardAsOf('x', '2026-01-01'), CoreUnavailableError);
  });
});

describe('requests', () => {
  it('sends the service key and a correlation id, and the right path and body', async () => {
    const seen = [];
    const c = client(async (url, init) => {
      seen.push({ url, init });
      return json(200, url.includes('working-minutes') ? { working_minutes: 7 } : standard);
    });
    await c.standardAsOf('11111111-1111-4111-8111-111111111111', '2026-11-10');
    await c.workingMinutes({ start: new Date('2026-11-10T01:00:00Z'), end: '2026-11-10T02:00:00Z', officeId: 'office' });
    assert.equal(seen[0].url, 'http://core.test/api/services/11111111-1111-4111-8111-111111111111/standard?asOf=2026-11-10');
    assert.equal(seen[0].init.method, 'GET');
    assert.equal(seen[0].init.headers['x-service-key'], KEY);
    assert.ok(seen[0].init.headers['x-correlation-id']);
    assert.equal(seen[1].url, 'http://core.test/api/working-minutes');
    assert.equal(seen[1].init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(seen[1].init.body), { start: '2026-11-10T01:00:00.000Z', end: '2026-11-10T02:00:00Z', officeId: 'office' });
  });

  it('returns usable values: whole minutes, instants in ms, the standard and the office', async () => {
    const c = client(async (url) => {
      if (url.endsWith('/working-minutes')) return json(200, { working_minutes: 90 });
      if (url.endsWith('/deadline')) return json(200, { deadline: '2026-10-09T19:00:00+08:00' });
      if (url.endsWith('/add-working-minutes')) return json(200, { datetime: '2026-10-10T09:00:00+08:00' });
      if (url.includes('/offices/')) return json(200, { office: { office_id: 'o', is_active: true } });
      return json(200, standard);
    });
    assert.equal(await c.workingMinutes({ start: 'a', end: 'b', officeId: null }), 90);
    assert.equal(await c.deadline({ start: new Date(), workingDays: 3, officeId: 'o' }), Date.parse('2026-10-09T19:00:00+08:00'));
    assert.equal(await c.addWorkingMinutes({ datetime: new Date(), minutes: 5, officeId: 'o' }), Date.parse('2026-10-10T09:00:00+08:00'));
    assert.equal((await c.office('o')).is_active, true);
    assert.equal((await c.standardAsOf('s', '2026-01-01')).office_code, 'PUP-X');
  });
});

describe('retry and failure handling', () => {
  it('retries ONCE on a network error and succeeds', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return json(200, standard);
    });
    assert.equal((await c.standardAsOf('s', '2026-01-01')).standard_id, 's1');
    assert.equal(calls, 2);
  });

  it('retries once on a 5xx, then gives up as unavailable (two calls in total)', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return json(503, { error: { code: 'X', message: 'down' } });
    });
    await assert.rejects(c.standardAsOf('s', '2026-01-01'), CoreUnavailableError);
    assert.equal(calls, 2);
  });

  it('times out after the limit and retries once (the stand-in never answers)', async () => {
    let calls = 0;
    const server = createServer(() => {
      calls += 1; // never answers
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const c = createCoreClient({ baseUrl: `http://127.0.0.1:${server.address().port}/api`, serviceKey: KEY, timeoutMs: 80 });
    const started = Date.now();
    try {
      await assert.rejects(c.workingMinutes({ start: 'a', end: 'b', officeId: null }), (err) => err instanceof CoreUnavailableError && /in time/.test(err.message));
      assert.equal(calls, 2);
      assert.ok(Date.now() - started >= 150, 'waited for the timeout twice');
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it('does NOT retry a 4xx: it is Core\'s decision and is passed on with its code and message', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return json(404, { error: { code: 'SERVICE_NOT_FOUND', message: 'Service not found', details: null } });
    });
    await assert.rejects(c.standardAsOf('s', '2026-01-01'), (err) => err instanceof CoreRejectedError && err.status === 404 && err.code === 'SERVICE_NOT_FOUND' && err.message === 'Service not found');
    assert.equal(calls, 1);
  });

  it('treats unusable answers as unavailable (TC4-TXN-036)', async () => {
    for (const body of [{ working_minutes: -1 }, { working_minutes: 1.5 }, { working_minutes: '5' }, {}]) {
      await assert.rejects(client(async () => json(200, body)).workingMinutes({ start: 'a', end: 'b' }), CoreUnavailableError, JSON.stringify(body));
    }
    await assert.rejects(client(async () => json(200, { deadline: 'soon' })).deadline({ start: 'a', workingDays: 1 }), CoreUnavailableError);
    await assert.rejects(client(async () => json(200, { ...standard, duration_days: -1 })).standardAsOf('s', 'd'), CoreUnavailableError);
    await assert.rejects(client(async () => json(200, { ...standard, office_code: undefined })).standardAsOf('s', 'd'), CoreUnavailableError);
    await assert.rejects(client(async () => new Response('not json', { status: 200 })).workingMinutes({ start: 'a', end: 'b' }), CoreUnavailableError);
    await assert.rejects(client(async () => json(200, { office: {} })).office('o'), CoreUnavailableError);
  });
});
