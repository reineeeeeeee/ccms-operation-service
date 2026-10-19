const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The transaction as the API returns it. Client email and reference belong to the detail only (`detail: true`):
 * the list never carries them.
 */
export function toTransactionDto(row, { detail = true } = {}) {
  const dto = {
    transaction_id: row.transaction_id,
    tracking_no: row.tracking_no,
    service_id: row.service_id,
    service_code: row.service_code,
    service_name: row.service_name,
    service_classification: row.service_classification,
    office_id: row.office_id,
    office_code: row.office_code,
    standard_id: row.standard_id,
    standard_duration_days: row.standard_duration_days,
    standard_duration_hours: row.standard_duration_hours,
    standard_duration_minutes: row.standard_duration_minutes,
    counter_id: row.counter_id ?? null,
    counter_label: row.counter_label ?? null,
    client_type: row.client_type,
    status: row.status,
    started_at: iso(row.started_at),
    started_by: row.started_by,
    ended_at: iso(row.ended_at),
    ended_by: row.ended_by ?? null,
    elapsed_working_minutes: row.elapsed_working_minutes ?? null,
    is_compliant: row.is_compliant ?? null,
    variance_minutes: row.variance_minutes ?? null,
    is_backdated: row.is_backdated === true,
    held_minutes: row.held_minutes ?? 0,
    hold_started_at: iso(row.hold_started_at),
    receipt_email_status: row.receipt_email_status ?? 'NONE',
    version: row.version,
  };
  if (detail) {
    dto.client_reference = row.client_reference ?? null;
    dto.client_email = row.client_email ?? null;
    dto.hold_reason = row.hold_reason ?? null;
    dto.cancel_reason = row.cancel_reason ?? null;
    dto.backdate_reason = row.backdate_reason ?? null;
    dto.receipt_email_attempts = row.receipt_email_attempts ?? 0;
  }
  return dto;
}
