// Shared test setup (not a test file): a database, a fake Core, tokens and request helpers.
import { randomUUID } from 'node:crypto';
import { ROLES, setDataSource, setDefaultVerifier } from 'ccms-shared';
import { createTestDatabase, createTestKeys } from 'ccms-shared/testing';
import { afterSync } from '../src/lib/after-sync.js';
import { entities } from '../src/lib/entities/index.js';
import { at, startFakeCore } from './fake-core.js';

export const SERVICE_KEY = 'test-service-key-0123456789';
export const OFFICE_A = randomUUID();
export const OFFICE_B = randomUUID();
export const USERS = {
  adminId: randomUUID(),
  headA: randomUUID(),
  staffA: randomUUID(),
  staffA2: randomUUID(),
  headB: randomUUID(),
  staffB: randomUUID(),
  execId: randomUUID(),
};

export const tokens = { superAdmin: null, executive: null, officeHeadA: null, officeStaffA: null, officeStaffA2: null, officeHeadB: null, officeStaffB: null };

export async function setupTestEnv() {
  process.env.SERVICE_KEY = SERVICE_KEY;
  delete process.env.LOGS_SERVICE_URL;
  const core = await startFakeCore({ serviceKey: SERVICE_KEY });
  process.env.CORE_URL = core.url;
  core.addOffice({ office_id: OFFICE_A, office_code: 'PUP-OSAS', office_name: 'Student Affairs' });
  core.addOffice({ office_id: OFFICE_B, office_code: 'PUP-ACAD', office_name: 'Academic Affairs' });
  const keys = await createTestKeys();
  setDefaultVerifier(keys.verifier);
  const testDb = await createTestDatabase({ entities, afterSync });
  setDataSource(testDb.dataSource);
  Object.assign(tokens, {
    superAdmin: await keys.signToken({ sub: USERS.adminId, role: ROLES.SUPER_ADMIN, full_name: 'Sam Admin' }),
    executive: await keys.signToken({ sub: USERS.execId, role: ROLES.EXECUTIVE }),
    officeHeadA: await keys.signToken({ sub: USERS.headA, role: ROLES.OFFICE_HEAD, office_id: OFFICE_A }),
    officeStaffA: await keys.signToken({ sub: USERS.staffA, role: ROLES.OFFICE_STAFF, office_id: OFFICE_A }),
    officeStaffA2: await keys.signToken({ sub: USERS.staffA2, role: ROLES.OFFICE_STAFF, office_id: OFFICE_A }),
    officeHeadB: await keys.signToken({ sub: USERS.headB, role: ROLES.OFFICE_HEAD, office_id: OFFICE_B }),
    officeStaffB: await keys.signToken({ sub: USERS.staffB, role: ROLES.OFFICE_STAFF, office_id: OFFICE_B }),
  });
  return {
    ds: testDb.dataSource,
    core,
    keys,
    tokens,
    async teardown() {
      setDataSource(null);
      await testDb.drop();
      await core.close();
      delete process.env.CORE_URL;
    },
  };
}

export const req = (method, path, { token, body, headers, key } = {}) =>
  new Request(`http://localhost/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'x-service-key': key } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

export const ctx = (id, extra = {}) => ({ params: Promise.resolve({ id, ...extra }) });

/** Calls a route handler and returns { status, body, headers }. */
export async function call(handler, request, context) {
  const response = await handler(request, context);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

export const SERVICE_A = randomUUID();
export const SERVICE_B = randomUUID();

/** Registers the standard test services in the fake Core: A (office A, 3 working days), B (office B, 1 hour). */
export function seedCoreServices(core) {
  core.addService({
    service_id: SERVICE_A,
    office_id: OFFICE_A,
    office_code: 'PUP-OSAS',
    service_code: 'PUP-OSAS-TOR-001',
    service_name: 'Transcript of Records',
    classification: 'COMPLEX',
    standards: [{ from: '2025-01-01', to: null, standard_id: randomUUID(), days: 3, hours: 0, minutes: 0 }],
  });
  core.addService({
    service_id: SERVICE_B,
    office_id: OFFICE_B,
    office_code: 'PUP-ACAD',
    service_code: 'PUP-ACAD-ENR-001',
    service_name: 'Enrollment Slip',
    classification: 'SIMPLE',
    standards: [{ from: '2025-01-01', to: null, standard_id: randomUUID(), days: 0, hours: 1, minutes: 0 }],
  });
}

export const resetData = async (ds) => {
  await ds.query('DELETE FROM transactions');
  await ds.query('DELETE FROM tracking_sequences');
  await ds.query('DELETE FROM counters');
  await ds.query('DELETE FROM audit_outbox');
  await ds.query('UPDATE transaction_settings SET hold_enabled = false, counters_enabled = false, auto_close_days_simple = NULL, auto_close_days_complex = NULL, auto_close_days_highly_technical = NULL, version = 1');
};

export { at };

let trackingCounter = 0;

/**
 * Inserts a transaction row directly (for tests that need exact times, results or statuses). Defaults: an open
 * transaction of service A in office A, started by a random user so the one-open rule never gets in the way.
 */
export async function insertTransaction(ds, over = {}) {
  trackingCounter += 1;
  const row = {
    transaction_id: randomUUID(),
    tracking_no: `PUP-OSAS-20260101-${String(trackingCounter).padStart(4, '0')}-${randomUUID().slice(0, 4)}`,
    service_id: SERVICE_A,
    service_code: 'PUP-OSAS-TOR-001',
    service_name: 'Transcript of Records',
    office_id: OFFICE_A,
    office_code: 'PUP-OSAS',
    service_classification: 'COMPLEX',
    standard_id: randomUUID(),
    standard_duration_days: 3,
    standard_duration_hours: 0,
    standard_duration_minutes: 0,
    counter_id: null,
    client_type: 'STUDENT',
    client_reference: null,
    client_email: null,
    started_at: new Date(Date.now() - 3600_000),
    started_by: randomUUID(),
    ended_at: null,
    ended_by: null,
    status: 'IN_PROGRESS',
    held_minutes: 0,
    hold_started_at: null,
    hold_reason: null,
    cancel_reason: null,
    elapsed_working_minutes: null,
    is_compliant: null,
    variance_minutes: null,
    is_backdated: false,
    receipt_email_status: 'NONE',
    receipt_email_attempts: 0,
    ...over,
  };
  const columns = Object.keys(row);
  await ds.query(
    `INSERT INTO transactions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    columns.map((c) => row[c]),
  );
  return row;
}

export const staff = (id, officeId = OFFICE_A) => ({ id, role: ROLES.OFFICE_STAFF, officeId });
export const head = (id, officeId = OFFICE_A) => ({ id, role: ROLES.OFFICE_HEAD, officeId });
export const admin = (id = USERS.adminId) => ({ id, role: ROLES.SUPER_ADMIN, officeId: null });
