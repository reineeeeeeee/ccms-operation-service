import { Errors, ROLES } from 'ccms-shared';

/** Roles that work with transactions. Executive never sees citizen-service records (BR-TXN-009): they get 403. */
export const OPERATOR_ROLES = Object.freeze([ROLES.SUPER_ADMIN, ROLES.OFFICE_HEAD, ROLES.OFFICE_STAFF]);

/**
 * Who may see and act on one transaction:
 *   Super Admin           any
 *   Office Head           the transactions of the office in their token
 *   Office Staff          their own (started_by) - even after a move to another office
 * Anyone else, including Executive, is refused.
 */
export function canAccessTransaction(user, row) {
  if (user.role === ROLES.SUPER_ADMIN) return true;
  if (user.role === ROLES.OFFICE_HEAD) return Boolean(user.officeId) && String(row.office_id) === String(user.officeId);
  if (user.role === ROLES.OFFICE_STAFF) return String(row.started_by) === String(user.id);
  return false;
}

export function assertCanAccess(user, row) {
  if (!canAccessTransaction(user, row)) throw Errors.forbidden();
}

/** Cancelling is for supervisors only: Office Head of the office, or Super Admin (B11). */
export function assertCanCancel(user, row) {
  if (user.role === ROLES.SUPER_ADMIN) return;
  if (user.role === ROLES.OFFICE_HEAD && user.officeId && String(row.office_id) === String(user.officeId)) return;
  throw Errors.forbidden();
}
