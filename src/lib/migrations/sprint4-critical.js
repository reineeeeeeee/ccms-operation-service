export async function migrateSprint4Operations(dataSource) {
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(43436, 401)');
    // Unknown historical office names stay null: current names cannot establish the name at the original Start.
    await manager.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS office_name text');
    await manager.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_email_claim_token uuid');
    await manager.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_email_claim_until timestamptz');
    await manager.query('ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_receipt_status_ck');
    await manager.query(`ALTER TABLE transactions ADD CONSTRAINT transactions_receipt_status_ck CHECK (
      receipt_email_status IN ('NONE','PENDING','SENDING','SENT','FAILED') AND receipt_email_attempts >= 0 AND
      ((receipt_email_status = 'SENDING' AND receipt_email_claim_token IS NOT NULL AND receipt_email_claim_until IS NOT NULL) OR
       (receipt_email_status <> 'SENDING' AND receipt_email_claim_token IS NULL AND receipt_email_claim_until IS NULL)))`);
  });
}
