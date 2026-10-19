import { randomUUID } from 'node:crypto';
import { ROLES, Errors, isUniqueViolation, isUuid, recordAudit } from 'ccms-shared';
import { kickOutbox } from '../../lib/outbox.js';
import { CoreRejectedError, CoreUnavailableError } from './core-client.js';
import { MSG, OPEN_STATUSES } from './constants.js';
import { rowsOf } from './db.js';

export const LABEL_TAKEN = 'This office already has a counter with this label';
export const OFFICE_INACTIVE = 'Office not found or inactive';
export const COUNTER_HAS_OPEN = 'This counter has an open transaction';

export function toCounterDto(row) {
  return { counter_id: row.counter_id, office_id: row.office_id, label: row.label, is_active: row.is_active };
}

/** { office_id, label }: the office is a plain ID (Core owns offices); the label is 1-50 characters, unique per office in any letter case. */
export function parseCounterInput(body) {
  const details = {};
  const officeId = typeof body.office_id === 'string' ? body.office_id.trim() : '';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!isUuid(officeId)) details.office_id = 'Office is required';
  if (!label) details.label = 'Counter label is required';
  else if (label.length > 50) details.label = 'Counter label must be 50 characters or fewer';
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return { officeId, label };
}

/** The office must exist and be active in Core (service key; Core also answers for inactive offices, so the check is here). */
async function requireActiveOffice(core, officeId) {
  try {
    const office = await core.office(officeId);
    if (!office.is_active) throw Errors.conflict(OFFICE_INACTIVE, 'OFFICE_INACTIVE');
  } catch (err) {
    if (err instanceof CoreRejectedError && (err.status === 404 || err.status === 400)) throw Errors.conflict(OFFICE_INACTIVE, 'OFFICE_INACTIVE');
    if (err instanceof CoreUnavailableError) throw Errors.unavailable(MSG.CATALOGUE_DOWN, 'CATALOGUE_UNAVAILABLE');
    throw err;
  }
}

function audit(manager, actor, action, before, after, ipAddress) {
  const counter = after ?? before;
  return recordAudit(manager, {
    actor,
    action,
    entityType: 'counter',
    entityId: counter.counter_id,
    officeId: counter.office_id,
    before,
    after,
    ipAddress,
  });
}

async function lockCounter(manager, id) {
  const rows = isUuid(id) ? await manager.query('SELECT * FROM counters WHERE counter_id = $1 FOR UPDATE', [id]) : [];
  if (!rows[0]) throw Errors.notFound('Counter not found', 'COUNTER_NOT_FOUND');
  return rows[0];
}

async function assertNoOpenTransaction(manager, counterId) {
  const open = await manager.query(`SELECT 1 FROM transactions WHERE counter_id = $1 AND status IN ('${OPEN_STATUSES.join("', '")}') LIMIT 1`, [counterId]);
  if (open.length) throw Errors.conflict(COUNTER_HAS_OPEN, 'COUNTER_HAS_OPEN_TRANSACTION');
}

function mapLabelClash(err) {
  if (isUniqueViolation(err, 'counters_office_label_uq')) return Errors.conflict(LABEL_TAKEN, 'COUNTER_LABEL_EXISTS', { label: LABEL_TAKEN });
  return null;
}

export async function createCounter(dataSource, core, actor, body, { ipAddress } = {}) {
  const { officeId, label } = parseCounterInput(body);
  await requireActiveOffice(core, officeId);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const taken = await manager.query('SELECT 1 FROM counters WHERE office_id = $1 AND lower(label) = lower($2) LIMIT 1', [officeId, label]);
      if (taken.length) throw Errors.conflict(LABEL_TAKEN, 'COUNTER_LABEL_EXISTS', { label: LABEL_TAKEN });
      const rows = rowsOf(await manager.query('INSERT INTO counters (counter_id, office_id, label, is_active) VALUES ($1, $2, $3, true) RETURNING *', [randomUUID(), officeId, label]));
      const created = toCounterDto(rows[0]);
      await audit(manager, actor, 'COUNTER_CREATED', null, created, ipAddress);
      return created;
    });
    kickOutbox();
    return dto;
  } catch (err) {
    throw mapLabelClash(err) ?? err;
  }
}

/** Edit the label and/or move the counter to another office. Refused while the counter has an open transaction. */
export async function updateCounter(dataSource, core, actor, id, body, { ipAddress } = {}) {
  const { officeId, label } = parseCounterInput(body);
  // The call to Core happens before the database transaction, so a slow Core never holds a lock.
  const current = isUuid(id) ? (await dataSource.query('SELECT office_id FROM counters WHERE counter_id = $1', [id]))[0] : null;
  if (current && current.office_id !== officeId) await requireActiveOffice(core, officeId);
  try {
    const dto = await dataSource.transaction(async (manager) => {
      const existing = await lockCounter(manager, id);
      const before = toCounterDto(existing);
      if (before.office_id === officeId && before.label === label) return before;
      await assertNoOpenTransaction(manager, id);
      const taken = await manager.query('SELECT 1 FROM counters WHERE office_id = $1 AND lower(label) = lower($2) AND counter_id <> $3 LIMIT 1', [officeId, label, id]);
      if (taken.length) throw Errors.conflict(LABEL_TAKEN, 'COUNTER_LABEL_EXISTS', { label: LABEL_TAKEN });
      const rows = rowsOf(await manager.query('UPDATE counters SET office_id = $1, label = $2 WHERE counter_id = $3 RETURNING *', [officeId, label, id]));
      const after = toCounterDto(rows[0]);
      await audit(manager, actor, 'COUNTER_UPDATED', before, after, ipAddress);
      return after;
    });
    kickOutbox();
    return dto;
  } catch (err) {
    throw mapLabelClash(err) ?? err;
  }
}

/** Deactivate or reactivate (a counter is never deleted). Doing it twice is a no-op (no second audit entry). */
export async function setCounterActive(dataSource, actor, id, isActive, { ipAddress } = {}) {
  const dto = await dataSource.transaction(async (manager) => {
    const existing = await lockCounter(manager, id);
    const before = toCounterDto(existing);
    if (existing.is_active === isActive) return before;
    if (!isActive) await assertNoOpenTransaction(manager, id);
    const rows = rowsOf(await manager.query('UPDATE counters SET is_active = $1 WHERE counter_id = $2 RETURNING *', [isActive, id]));
    const after = toCounterDto(rows[0]);
    await audit(manager, actor, isActive ? 'COUNTER_REACTIVATED' : 'COUNTER_DEACTIVATED', before, after, ipAddress);
    return after;
  });
  kickOutbox();
  return dto;
}

/**
 * GET /counters?officeId=. Super Admin sees every office (optionally one); Office Head and Office Staff only their own
 * office (another office is a 403). Executive has no counters (they never work with transactions).
 */
export async function listCounters(dataSource, user, { officeId } = {}) {
  if (officeId && !isUuid(officeId)) throw Errors.validation('officeId must be a valid ID', { officeId: 'officeId must be a valid ID' });
  let scoped = officeId || null;
  if (user.role === ROLES.OFFICE_HEAD || user.role === ROLES.OFFICE_STAFF) {
    if (!user.officeId || (officeId && officeId.toLowerCase() !== String(user.officeId).toLowerCase())) throw Errors.forbidden();
    scoped = user.officeId;
  } else if (user.role !== ROLES.SUPER_ADMIN) {
    throw Errors.forbidden();
  }
  const rows = scoped
    ? await dataSource.query('SELECT * FROM counters WHERE office_id = $1 ORDER BY lower(label), counter_id', [scoped])
    : await dataSource.query('SELECT * FROM counters ORDER BY office_id, lower(label), counter_id');
  return { items: rows.map(toCounterDto) };
}
