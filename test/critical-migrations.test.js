import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { createTestDatabase } from 'ccms-shared/testing';
import { migrateSprint4Operations } from '../src/lib/migrations/sprint4-critical.js';

it('migrates legacy receipt rows twice without inventing historical office names or altering identifiers', async () => {
  const database = await createTestDatabase({ entities: [] });
  try {
    const ds = database.dataSource, id = randomUUID();
    await ds.query(`CREATE TABLE transactions (transaction_id uuid PRIMARY KEY, tracking_no text,
      office_code text, receipt_email_status text, receipt_email_attempts int)`);
    await ds.query("INSERT INTO transactions VALUES ($1, 'PUP-OSAS-20261001-0001', 'PUP-OSAS', 'PENDING', 2)", [id]);
    await migrateSprint4Operations(ds); await migrateSprint4Operations(ds);
    assert.deepEqual(await ds.query('SELECT * FROM transactions'), [{ transaction_id: id, tracking_no: 'PUP-OSAS-20261001-0001', office_code: 'PUP-OSAS', receipt_email_status: 'PENDING', receipt_email_attempts: 2, office_name: null, receipt_email_claim_token: null, receipt_email_claim_until: null }]);
    await assert.rejects(ds.query("UPDATE transactions SET receipt_email_status='SENDING'"), (error) => error.code === '23514');
    await assert.rejects(ds.query('UPDATE transactions SET receipt_email_attempts=-1'), (error) => error.code === '23514');
  } finally { await database.drop(); }
});
