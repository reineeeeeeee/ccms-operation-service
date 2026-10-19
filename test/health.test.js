// TT1: GET /api/health -> 200 { status: "UP" } when the database answers, 503 in the standard error format when it does not.
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { setDataSource } from 'ccms-shared';
import { GET } from '../src/app/api/health/route.js';
import { setupTestEnv } from './helpers.js';

let env;
before(async () => {
  env = await setupTestEnv();
});
after(async () => env?.teardown());

describe('health endpoint (TT1-T3)', () => {
  it('answers 200 { status: "UP" } with a correlation id when the database is up', async () => {
    const response = await GET(new Request('http://localhost/api/health'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'UP' });
    assert.ok(response.headers.get('x-correlation-id'));
  });

  it('answers 503 in the standard error format when the database cannot be reached', async () => {
    setDataSource({
      query: async () => {
        throw new Error('connection refused');
      },
    });
    try {
      const response = await GET(new Request('http://localhost/api/health'));
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, 'DATABASE_UNAVAILABLE');
      assert.ok(body.error.correlation_id && body.error.timestamp);
      assert.ok(!JSON.stringify(body).includes('connection refused'), 'no internal detail leaks');
    } finally {
      setDataSource(env.ds);
    }
  });
});
