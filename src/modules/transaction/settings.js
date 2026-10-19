import { Errors, recordAudit } from 'ccms-shared';
import { DEFAULT_SETTINGS_SQL } from '../../lib/after-sync.js';
import { kickOutbox } from '../../lib/outbox.js';
import { rowsOf } from './db.js';

// TT5: one settings record. Hold off (B20), counters off (B22), auto-close days per classification (B21), empty = off.
export const SETTINGS_CONFLICT = 'Settings were changed by someone else. Reload and try again.';
export const AUTO_CLOSE_MESSAGE = 'Enter a whole number of working days from 1 to 365, or leave empty to turn auto-close off';

const AUTO_CLOSE_FIELDS = ['auto_close_days_simple', 'auto_close_days_complex', 'auto_close_days_highly_technical'];

/** The classification -> settings column map used by auto-close (CC028). */
export const AUTO_CLOSE_BY_CLASSIFICATION = Object.freeze({
  SIMPLE: 'auto_close_days_simple',
  COMPLEX: 'auto_close_days_complex',
  HIGHLY_TECHNICAL: 'auto_close_days_highly_technical',
});

export function toSettingsDto(row) {
  return {
    hold_enabled: row.hold_enabled,
    counters_enabled: row.counters_enabled,
    auto_close_days_simple: row.auto_close_days_simple ?? null,
    auto_close_days_complex: row.auto_close_days_complex ?? null,
    auto_close_days_highly_technical: row.auto_close_days_highly_technical ?? null,
    version: row.version,
  };
}

/** The settings row; created with the defaults if it is somehow missing. `manager` is a data source or a transaction manager. */
export async function readSettingsRow(manager) {
  let rows = await manager.query('SELECT * FROM transaction_settings WHERE id = 1');
  if (!rows[0]) {
    await manager.query(DEFAULT_SETTINGS_SQL);
    rows = await manager.query('SELECT * FROM transaction_settings WHERE id = 1');
  }
  return rows[0];
}

export async function getSettings(dataSource) {
  return toSettingsDto(await readSettingsRow(dataSource));
}

/**
 * PUT /settings body: the full settings and the version that was read.
 *   hold_enabled, counters_enabled   true or false
 *   auto_close_days_*                empty (null or ''), or a whole number from 1 to 365
 */
export function parseSettingsInput(body) {
  const details = {};
  const out = {};
  for (const field of ['hold_enabled', 'counters_enabled']) {
    if (typeof body[field] !== 'boolean') details[field] = `${field} must be true or false`;
    else out[field] = body[field];
  }
  for (const field of AUTO_CLOSE_FIELDS) {
    const value = body[field];
    if (value === undefined) details[field] = AUTO_CLOSE_MESSAGE;
    else if (value === null || value === '') out[field] = null;
    else {
      const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
      if (!Number.isInteger(number) || number < 1 || number > 365) details[field] = AUTO_CLOSE_MESSAGE;
      else out[field] = number;
    }
  }
  if (!Number.isInteger(body.version) || body.version < 1) details.version = 'version is required: send the version you read';
  else out.version = body.version;
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return out;
}

const sameValues = (a, b) => ['hold_enabled', 'counters_enabled', ...AUTO_CLOSE_FIELDS].every((field) => (a[field] ?? null) === (b[field] ?? null));

/**
 * Super Admin changes the settings. The update only happens when the version matches the stored one (409
 * SETTINGS_VERSION_CONFLICT otherwise, nothing overwritten) and then increments it. Saving the values that are
 * already stored changes nothing and writes no audit entry. Audited: TRANSACTION_SETTINGS_UPDATED (office_id null).
 */
export async function updateSettings(dataSource, actor, body, { ipAddress } = {}) {
  const input = parseSettingsInput(body);
  const dto = await dataSource.transaction(async (manager) => {
    const current = await readSettingsRow(manager);
    if (current.version !== input.version) throw Errors.conflict(SETTINGS_CONFLICT, 'SETTINGS_VERSION_CONFLICT');
    const before = toSettingsDto(current);
    if (sameValues(before, input)) return before;
    const rows = rowsOf(
      await manager.query(
        `UPDATE transaction_settings SET hold_enabled = $1, counters_enabled = $2, auto_close_days_simple = $3,
                auto_close_days_complex = $4, auto_close_days_highly_technical = $5, version = version + 1,
                updated_at = now(), updated_by = $6
          WHERE id = 1 AND version = $7 RETURNING *`,
        [input.hold_enabled, input.counters_enabled, input.auto_close_days_simple, input.auto_close_days_complex, input.auto_close_days_highly_technical, actor.id, input.version],
      ),
    );
    if (!rows[0]) throw Errors.conflict(SETTINGS_CONFLICT, 'SETTINGS_VERSION_CONFLICT');
    const after = toSettingsDto(rows[0]);
    await recordAudit(manager, {
      actor,
      action: 'TRANSACTION_SETTINGS_UPDATED',
      entityType: 'transaction_settings',
      entityId: 'settings',
      officeId: null,
      before,
      after,
      ipAddress,
    });
    return after;
  });
  kickOutbox();
  return dto;
}
