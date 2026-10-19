// CC023 compliance: pure arithmetic on the numbers Core answers with (working minutes, deadlines). No database and no clock.
//
// The standard has three parts: days, hours, minutes (C21). Days are never turned into minutes (B5): they are counted to a
// deadline day by Core; only the hours/minutes part and the held time are working minutes.
//
//   days part = 0   elapsed = working_minutes(start, end) - held;  limit = hours*60 + minutes
//                   compliant = elapsed <= limit;                  variance = elapsed - limit
//   days part N > 0 D1 = deadline(start, N days, held 0);  deadline = D1 + (hours*60 + minutes + held) working minutes
//                   compliant = end <= deadline
//                   variance = -working_minutes(end, deadline) when end <= deadline, +working_minutes(deadline, end) otherwise
//                   elapsed  = working_minutes(start, end) - held
// A negative variance means finished before the deadline; positive means late.

/** The time part of the standard in working minutes. */
export function timeLimitMinutes({ hours, minutes }) {
  return hours * 60 + minutes;
}

/** Days part = 0: everything is compared in working minutes. */
export function evaluateTimeOnly({ elapsedGross, held, hours, minutes }) {
  const elapsed = elapsedGross - held;
  const limit = timeLimitMinutes({ hours, minutes });
  return { elapsed, isCompliant: elapsed <= limit, variance: elapsed - limit };
}

/** Days part > 0: `gapMinutes` is the working minutes between the end and the deadline (whichever comes first to last). */
export function evaluateAgainstDeadline({ elapsedGross, held, endMs, deadlineMs, gapMinutes }) {
  const isCompliant = endMs <= deadlineMs;
  const variance = isCompliant ? 0 - gapMinutes : gapMinutes;
  return { elapsed: elapsedGross - held, isCompliant, variance: variance === 0 ? 0 : variance };
}

/**
 * Asks Core for what the rule needs and applies it. `snapshot` is the part of the transaction that was copied at the start
 * (B4) plus the two timestamps and the held total:
 *   { startedAt, endedAt, heldMinutes, officeId, days, hours, minutes }.
 * Throws whatever the Core client throws (CoreUnavailableError / CoreRejectedError); the caller decides what that means.
 */
export async function computeCompliance(core, snapshot) {
  const { startedAt, endedAt, heldMinutes: held, officeId, days, hours, minutes } = snapshot;
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  // Core refuses an end that is not after the start; a transaction finished within the same instant has no working time.
  const grossOf = (from, to) => (to > from ? core.workingMinutes({ start: new Date(from), end: new Date(to), officeId }) : Promise.resolve(0));

  if (days === 0) {
    return evaluateTimeOnly({ elapsedGross: await grossOf(startMs, endMs), held, hours, minutes });
  }
  const firstDeadlineMs = await core.deadline({ start: new Date(startMs), workingDays: days, officeId, heldMinutes: 0 });
  const deadlineMs = await core.addWorkingMinutes({ datetime: new Date(firstDeadlineMs), minutes: timeLimitMinutes({ hours, minutes }) + held, officeId });
  const [elapsedGross, gapMinutes] = await Promise.all([
    grossOf(startMs, endMs),
    endMs <= deadlineMs ? grossOf(endMs, deadlineMs) : grossOf(deadlineMs, endMs),
  ]);
  return evaluateAgainstDeadline({ elapsedGross, held, endMs, deadlineMs, gapMinutes });
}
