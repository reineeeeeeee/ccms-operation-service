import { Errors } from 'ccms-shared';
import { MSG } from './constants.js';

// An ISO-8601 timestamp must carry its own offset: without one the parser would read it in the server's local
// time zone and the result would change with the server clock.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** A Date for an ISO timestamp with an offset, or null when it cannot be read. */
export function parseInstant(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!ISO_WITH_OFFSET.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Reads the optional times of a record entered after the fact (CC026). Returns { startedAt, endedAt, backdateReason }
 * (all null when neither time was supplied). Throws 400 naming the field.
 *   started_at must be before now; ended_at must be after started_at and not after now; a reason of 1-500 characters is required.
 *   ended_at is only accepted together with started_at when a transaction is started; on completion `startedAt` is the stored one.
 */
export function parseBackdate(body, { now, storedStart = null, allowStart = true } = {}) {
  const details = {};
  const given = (value) => value !== undefined && value !== null && value !== '';
  let startedAt = null;
  let endedAt = null;

  if (given(body.started_at)) {
    startedAt = allowStart ? parseInstant(body.started_at) : null;
    if (!allowStart) details.started_at = 'The start time cannot be changed here';
    else if (!startedAt) details.started_at = 'Enter the start as a date and time';
    else if (startedAt.getTime() >= now.getTime()) details.started_at = MSG.FUTURE;
  }
  if (given(body.ended_at)) {
    endedAt = parseInstant(body.ended_at);
    const start = startedAt ?? storedStart;
    if (!endedAt) details.ended_at = 'Enter the end as a date and time';
    else if (endedAt.getTime() > now.getTime()) details.ended_at = MSG.FUTURE;
    else if (!start && allowStart) details.started_at ??= 'Enter the start time of a transaction recorded after the fact';
    else if (start && endedAt.getTime() <= start.getTime()) details.ended_at = MSG.END_AFTER_START;
  }

  let backdateReason = null;
  if (startedAt || endedAt || given(body.started_at) || given(body.ended_at)) {
    const reason = typeof body.backdate_reason === 'string' ? body.backdate_reason.trim() : '';
    if (!reason || reason.length > 500) details.backdate_reason = MSG.BACKDATE_REASON;
    else backdateReason = reason;
  }
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return { startedAt, endedAt, backdateReason };
}

/** 'MM/DD/YYYY' for messages, from a 'YYYY-MM-DD' Manila date. */
export function usDate(manilaDate) {
  const [y, m, d] = manilaDate.split('-');
  return `${m}/${d}/${y}`;
}
