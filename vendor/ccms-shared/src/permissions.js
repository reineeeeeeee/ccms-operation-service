import { authenticate } from './auth.js';
import { Errors } from './errors.js';
import { ROLES, isOfficeBound } from './roles.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * requirePermission(roles, officeScope) — used by every route.
 *
 *   roles        roles allowed to call the route.
 *   officeScope  'campus'  no per-office restriction beyond the role (default)
 *                'office'  Office Head / Office Staff may only touch their own office's data.
 *
 * Returns an async check(request, { officeId }) that resolves to the caller or throws 401/403.
 * For 'office' routes pass the office that owns the target resource as { officeId } (use null for
 * a resource that has no office). List routes should not pass it and must filter with officeFilter().
 *
 * Rules (the server decides; hiding buttons is not enforcement):
 *   - Super Admin: campus-wide read and write.
 *   - Executive: read-only everywhere (any non-GET/HEAD/OPTIONS call is a 403).
 *   - Office Head / Office Staff: limited to their bound office.
 */
export function requirePermission(roles, officeScope = 'campus', { verifier } = {}) {
  return async function check(request, target = {}) {
    const user = await authenticate(request, verifier);

    if (!roles.includes(user.role)) throw Errors.forbidden();

    if (user.role === ROLES.EXECUTIVE && !SAFE_METHODS.has(request.method)) {
      throw Errors.forbidden('Executives have read-only access');
    }

    if (officeScope === 'office' && 'officeId' in target) assertOfficeAccess(user, target.officeId);
    return user;
  };
}

/**
 * Throws 403 when an Office Head / Office Staff caller touches an office other than their own
 * (a resource with no office also counts as "not theirs"). Other roles pass. Use it after loading
 * a resource whose office you did not know before the role check.
 */
export function assertOfficeAccess(user, officeId) {
  if (isOfficeBound(user.role) && (!officeId || String(officeId) !== String(user.officeId))) {
    throw Errors.forbidden();
  }
}

/** The office a list query must be limited to, or null when the caller may see every office. */
export function officeFilter(user) {
  return isOfficeBound(user.role) ? user.officeId : null;
}
