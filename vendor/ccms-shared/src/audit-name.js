// Only administrative labels and transaction tracking numbers may enter the audit name field.
export const AUDIT_NAME_MAX = 300;
const FIELD_BY_TYPE = Object.freeze({
  office: 'office_name', service: 'service_name', account: 'full_name',
  required_document: 'document_name', requireddocument: 'document_name',
  term_date: 'term_name', counter: 'label', calendar_exception: 'description',
});
const FIXED_NAMES = Object.freeze({
  working_hours: 'Campus working hours', transaction_settings: 'Transaction settings',
  catalogue_settings: 'Institution and calendar settings',
});
const ADMIN_TYPES = new Set([...Object.keys(FIELD_BY_TYPE), ...Object.keys(FIXED_NAMES), 'servicestandard', 'service_standard']);
export const isSafeAuditText = (value) => typeof value === 'string' && value.trim().length > 0
  && value.length <= AUDIT_NAME_MAX && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  && !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value);
export const isTrackingName = (value) => isSafeAuditText(value) && /^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{8}-\d{4}$/.test(value);

/** Never guess a name from arbitrary keys, client fields, reasons, or applicant data. */
export function auditEntityName(event) {
  const type = String(event.entityType ?? '').toLowerCase();
  if (type === 'transaction') {
    const tracking = event.after?.tracking_no ?? event.before?.tracking_no ?? event.entityName;
    return isTrackingName(tracking) ? tracking : null;
  }
  if (!ADMIN_TYPES.has(type)) return null;
  if (FIXED_NAMES[type]) return FIXED_NAMES[type];
  const key = FIELD_BY_TYPE[type];
  const candidate = event.entityName ?? (key ? event.after?.[key] ?? event.before?.[key] : null);
  if (isSafeAuditText(candidate)) return candidate.trim();
  if (type === 'calendar_exception') {
    const date = event.after?.exception_date ?? event.before?.exception_date;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `Calendar entry ${date}`;
  }
  return null;
}

export function validIncomingAuditName(type, value) {
  if (value === null || value === undefined) return true;
  const key = String(type ?? '').toLowerCase();
  return key === 'transaction' ? isTrackingName(value) : ADMIN_TYPES.has(key) && isSafeAuditText(value);
}
