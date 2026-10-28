import { migrateSprint4Operations } from './migrations/sprint4-critical.js';
// Runs after TypeORM has created the tables. Everything here is idempotent.
// TypeORM cannot declare expression indexes, partial unique indexes, foreign keys with our names or CHECK
// constraints, so the Transaction data rules live here as well as in the service code.
async function addConstraint(dataSource, table, name, definition) {
  const rows = await dataSource.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name]);
  if (!rows.length) await dataSource.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}`);
}

// The single settings row, created on first start with the defaults (hold off, counters off, auto-close off).
export const DEFAULT_SETTINGS_SQL = `
  INSERT INTO transaction_settings (id, hold_enabled, counters_enabled, version) VALUES (1, false, false, 1)
  ON CONFLICT (id) DO NOTHING`;

export const OPEN_STATUSES = "('IN_PROGRESS', 'ON_HOLD')";

export async function afterSync(dataSource) {
  await migrateSprint4Operations(dataSource);
  await settingsRules(dataSource);
  await counterRules(dataSource);
  await transactionRules(dataSource);
}

async function settingsRules(dataSource) {
  await addConstraint(dataSource, 'transaction_settings', 'transaction_settings_single_ck', 'CHECK (id = 1)');
  for (const column of ['auto_close_days_simple', 'auto_close_days_complex', 'auto_close_days_highly_technical']) {
    await addConstraint(
      dataSource,
      'transaction_settings',
      `transaction_settings_${column}_ck`,
      `CHECK (${column} IS NULL OR ${column} BETWEEN 1 AND 365)`,
    );
  }
  await addConstraint(dataSource, 'transaction_settings', 'transaction_settings_version_ck', 'CHECK (version >= 1)');
  await dataSource.query(DEFAULT_SETTINGS_SQL);
}

async function counterRules(dataSource) {
  // A counter label is unique within its office, ignoring letter case.
  await dataSource.query('CREATE UNIQUE INDEX IF NOT EXISTS counters_office_label_uq ON counters (office_id, lower(label))');
  await addConstraint(dataSource, 'counters', 'counters_label_ck', 'CHECK (char_length(btrim(label)) BETWEEN 1 AND 50)');
}

async function transactionRules(dataSource) {
  // Tracking numbers are unique.
  await dataSource.query('CREATE UNIQUE INDEX IF NOT EXISTS transactions_tracking_no_uq ON transactions (tracking_no)');
  // One open transaction per staff account (always) and per counter (when a counter is used).
  await dataSource.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_open_per_staff_uq ON transactions (started_by) WHERE status IN ${OPEN_STATUSES}`,
  );
  await dataSource.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_open_per_counter_uq ON transactions (counter_id) WHERE counter_id IS NOT NULL AND status IN ${OPEN_STATUSES}`,
  );
  // Lists and jobs.
  await dataSource.query('CREATE INDEX IF NOT EXISTS transactions_office_started_idx ON transactions (office_id, started_at DESC)');
  await dataSource.query('CREATE INDEX IF NOT EXISTS transactions_staff_started_idx ON transactions (started_by, started_at DESC)');
  await dataSource.query('CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions (status)');
  await dataSource.query('CREATE INDEX IF NOT EXISTS transactions_pending_result_idx ON transactions (status) WHERE elapsed_working_minutes IS NULL');
  await dataSource.query(`CREATE INDEX IF NOT EXISTS transactions_open_started_idx ON transactions (status, started_at) WHERE status IN ${OPEN_STATUSES}`);

  await addConstraint(
    dataSource,
    'transactions',
    'transactions_counter_fk',
    'FOREIGN KEY (counter_id) REFERENCES counters (counter_id)',
  );
  await addConstraint(
    dataSource,
    'transactions',
    'transactions_status_ck',
    "CHECK (status IN ('IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'AUTO_CLOSED'))",
  );
  await addConstraint(
    dataSource,
    'transactions',
    'transactions_client_type_ck',
    "CHECK (client_type IN ('STUDENT', 'ALUMNI', 'EMPLOYEE', 'EXTERNAL'))",
  );
  await addConstraint(
    dataSource,
    'transactions',
    'transactions_classification_ck',
    "CHECK (service_classification IN ('SIMPLE', 'COMPLEX', 'HIGHLY_TECHNICAL'))",
  );
  await addConstraint(
    dataSource,
    'transactions',
    'transactions_standard_ck',
    'CHECK (standard_duration_days >= 0 AND standard_duration_hours >= 0 AND standard_duration_minutes >= 0)',
  );
  await addConstraint(dataSource, 'transactions', 'transactions_held_ck', 'CHECK (held_minutes >= 0)');
  await addConstraint(dataSource, 'transactions', 'transactions_version_ck', 'CHECK (version >= 1)');
  // ON_HOLD if and only if hold_started_at is set (CC022).
  await addConstraint(
    dataSource,
    'transactions',
    'transactions_hold_ck',
    "CHECK ((status = 'ON_HOLD') = (hold_started_at IS NOT NULL))",
  );
  // A cancelled transaction always keeps its reason (CC025); any reason is 1-500 characters.
  await addConstraint(
    dataSource,
    'transactions',
    'transactions_cancel_reason_ck',
    "CHECK ((status <> 'CANCELLED' OR cancel_reason IS NOT NULL) AND (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 1 AND 500))",
  );
  await addConstraint(
    dataSource,
    'transactions',
    'transactions_receipt_status_ck',
    "CHECK (receipt_email_status IN ('NONE', 'PENDING', 'SENT', 'FAILED') AND receipt_email_attempts >= 0)",
  );
}
