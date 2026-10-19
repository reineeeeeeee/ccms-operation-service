import { ROLES, Errors, endOfManilaDay, fromManila, isUuid, isValidManilaDate } from 'ccms-shared';
import { STATUS_LIST } from './constants.js';
import { TRANSACTION_SELECT, loadTransactionRow, notFound } from './db.js';
import { toTransactionDto } from './dto.js';
import { assertCanAccess } from './access.js';

/** page / page_size from query parameters (defaults 1 / 20, size at most 100): the same shape as GET /services. */
export function parsePaging(params, { defaultSize = 20, maxSize = 100 } = {}) {
  const details = {};
  const read = (name, fallback, max) => {
    const raw = params.get(name);
    if (raw === null || raw === '') return fallback;
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) {
      details[name] = `${name} must be a whole number from 1 to ${max}`;
      return fallback;
    }
    return n;
  };
  const page = read('page', 1, 1_000_000);
  const pageSize = read('page_size', defaultSize, maxSize);
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return { page, pageSize };
}

const likePattern = (text) => `${text.replace(/[%_\\]/g, '\\$&')}%`;

/**
 * GET /transactions?status=&service_id=&counter_id=&office_id=&from=&to=&q=&page=&page_size=
 * Scope (BR-TXN-009), enforced here and not by hiding buttons:
 *   Super Admin    every office; office_id narrows it
 *   Office Head    the office in the token; another office_id is a 403
 *   Office Staff   their own records (started_by); another office_id is a 403
 *   Executive      403 (the route does not let them in)
 * Dates are Manila dates (from 00:00 to 23:59:59 of `to`); q is a tracking number or its start; newest first.
 * The list never carries the client's email or reference (they are on the detail page only).
 */
export async function listTransactions(dataSource, user, params) {
  const { page, pageSize } = parsePaging(params);
  const details = {};
  const status = params.get('status');
  const serviceId = params.get('service_id');
  const counterId = params.get('counter_id');
  const officeId = params.get('office_id');
  const from = params.get('from');
  const to = params.get('to');
  const q = params.get('q')?.trim();
  if (status && !STATUS_LIST.includes(status)) details.status = `Status must be one of ${STATUS_LIST.join(', ')}`;
  if (serviceId && !isUuid(serviceId)) details.service_id = 'service_id must be a valid ID';
  if (counterId && !isUuid(counterId)) details.counter_id = 'counter_id must be a valid ID';
  if (officeId && !isUuid(officeId)) details.office_id = 'office_id must be a valid ID';
  if (from && !isValidManilaDate(from)) details.from = 'From must be a date (YYYY-MM-DD)';
  if (to && !isValidManilaDate(to)) details.to = 'To must be a date (YYYY-MM-DD)';
  if (!details.from && !details.to && from && to && from > to) details.from = 'From date must be on or before To date';
  if (q && q.length > 60) details.q = 'q must be 60 characters or fewer';
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);

  const where = [];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (user.role === ROLES.SUPER_ADMIN) {
    if (officeId) add('t.office_id = ?::uuid', officeId);
  } else if (user.role === ROLES.OFFICE_HEAD || user.role === ROLES.OFFICE_STAFF) {
    if (!user.officeId || (officeId && officeId.toLowerCase() !== String(user.officeId).toLowerCase())) throw Errors.forbidden();
    if (user.role === ROLES.OFFICE_HEAD) add('t.office_id = ?::uuid', user.officeId);
    else add('t.started_by = ?::uuid', user.id);
  } else {
    throw Errors.forbidden();
  }
  if (status) add('t.status = ?', status);
  if (serviceId) add('t.service_id = ?::uuid', serviceId);
  if (counterId) add('t.counter_id = ?::uuid', counterId);
  if (from) add('t.started_at >= ?', fromManila(from));
  if (to) add('t.started_at <= ?', endOfManilaDay(fromManila(to)));
  if (q) add(`t.tracking_no ILIKE ? ESCAPE '\\'`, likePattern(q));
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const [{ total }] = await dataSource.query(`SELECT count(*)::int AS total FROM transactions t${whereSql}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await dataSource.query(
    `${TRANSACTION_SELECT}${whereSql} ORDER BY t.started_at DESC, t.transaction_id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: rows.map((row) => toTransactionDto(row, { detail: false })), page, page_size: pageSize, total };
}

/** GET /transactions/:id. Outside the caller's scope: 403 and no data. */
export async function getTransaction(dataSource, user, id) {
  const row = isUuid(id) ? await loadTransactionRow(dataSource, id) : null;
  if (!row) throw notFound();
  assertCanAccess(user, row);
  return toTransactionDto(row);
}
