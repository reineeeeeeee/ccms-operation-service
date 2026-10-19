// Time utilities. Rule: store timestamps in UTC; convert to and from Asia/Manila only for
// dates and times that people read or that business rules depend on. Never use the server's
// local-time date methods (getDay, getDate, setHours, ...): the CI check flags them.
//
// The Philippines has no daylight saving time, so Asia/Manila is always UTC+08:00.

export const MANILA_TIME_ZONE = 'Asia/Manila';
export const MANILA_OFFSET_HOURS = 8;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  return date;
}

/** Calendar parts of an instant as seen in Manila. weekday: 0 = Sunday ... 6 = Saturday. */
export function manilaParts(value) {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(toDate(value)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** 'YYYY-MM-DD' calendar date in Manila. */
export function toManilaDate(value) {
  const p = manilaParts(value);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** 'YYYY-MM-DD HH:mm:ss' in Manila. */
export function toManilaDateTime(value) {
  const p = manilaParts(value);
  return `${toManilaDate(value)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** 0 (Sunday) to 6 (Saturday), by the Manila calendar. */
export function manilaWeekday(value) {
  return manilaParts(value).weekday;
}

export function isValidManilaDate(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const [y, m, d] = dateString.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** The UTC instant for a Manila wall-clock date and time. */
export function fromManila(dateString, timeString = '00:00:00') {
  if (!isValidManilaDate(dateString)) throw new RangeError(`Invalid date: ${dateString}`);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeString);
  if (!match) throw new RangeError(`Invalid time: ${timeString}`);
  const [y, m, d] = dateString.split('-').map(Number);
  const [, hh, mm, ss = '00'] = match;
  return new Date(Date.UTC(y, m - 1, d, Number(hh) - MANILA_OFFSET_HOURS, Number(mm), Number(ss)));
}

/** UTC instant at 00:00:00 Manila time on the Manila calendar day containing `value`. */
export function startOfManilaDay(value) {
  return fromManila(toManilaDate(value));
}

/** UTC instant at 23:59:59.999 Manila time on the Manila calendar day containing `value`. */
export function endOfManilaDay(value) {
  return new Date(startOfManilaDay(value).getTime() + 24 * 60 * 60 * 1000 - 1);
}

/** ISO-8601 UTC string for storing timestamps. */
export function toUtcIso(value = new Date()) {
  return toDate(value).toISOString();
}
