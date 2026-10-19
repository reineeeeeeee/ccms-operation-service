// CC023-T1: the pure compliance arithmetic and the Core questions behind it. Core's answers come from the fake Core,
// whose calendar is fixture W (Tue-Fri 08:00-19:00, Sat 08:00-17:00, Sun and Mon closed).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeCompliance, evaluateAgainstDeadline, evaluateTimeOnly, timeLimitMinutes } from '../src/modules/transaction/compliance.js';
import { engine, at } from './fake-core.js';

describe('pure arithmetic', () => {
  it('days part = 0: elapsed = gross - held, limit = hours*60 + minutes, variance = elapsed - limit', () => {
    assert.equal(timeLimitMinutes({ hours: 1, minutes: 30 }), 90);
    assert.deepEqual(evaluateTimeOnly({ elapsedGross: 45, held: 0, hours: 1, minutes: 0 }), { elapsed: 45, isCompliant: true, variance: -15 });
    assert.deepEqual(evaluateTimeOnly({ elapsedGross: 60, held: 0, hours: 1, minutes: 0 }), { elapsed: 60, isCompliant: true, variance: 0 });
    assert.deepEqual(evaluateTimeOnly({ elapsedGross: 90, held: 0, hours: 1, minutes: 0 }), { elapsed: 90, isCompliant: false, variance: 30 });
    assert.deepEqual(evaluateTimeOnly({ elapsedGross: 90, held: 40, hours: 1, minutes: 0 }), { elapsed: 50, isCompliant: true, variance: -10 }, 'held time does not count');
    assert.deepEqual(evaluateTimeOnly({ elapsedGross: 3, held: 0, hours: 0, minutes: 7 }), { elapsed: 3, isCompliant: true, variance: -4 });
  });

  it('days part > 0: compliant when end <= deadline; variance is minus the working minutes early, plus the working minutes late', () => {
    const early = evaluateAgainstDeadline({ elapsedGross: 500, held: 20, endMs: 1000, deadlineMs: 2000, gapMinutes: 60 });
    assert.deepEqual(early, { elapsed: 480, isCompliant: true, variance: -60 });
    const exact = evaluateAgainstDeadline({ elapsedGross: 500, held: 0, endMs: 2000, deadlineMs: 2000, gapMinutes: 0 });
    assert.deepEqual(exact, { elapsed: 500, isCompliant: true, variance: 0 });
    assert.ok(Object.is(exact.variance, 0), 'never -0');
    const late = evaluateAgainstDeadline({ elapsedGross: 900, held: 0, endMs: 3000, deadlineMs: 2000, gapMinutes: 120 });
    assert.deepEqual(late, { elapsed: 900, isCompliant: false, variance: 120 });
  });
});

// A "Core" that is the fake calendar, called the way the real client would answer.
const fakeCore = (log = []) => {
  const cal = engine();
  return {
    log,
    async workingMinutes({ start, end }) {
      log.push(['wm', new Date(start).toISOString(), new Date(end).toISOString()]);
      return cal.workingMinutes(new Date(start).getTime(), new Date(end).getTime());
    },
    async deadline({ start, workingDays, heldMinutes }) {
      log.push(['deadline', workingDays, heldMinutes]);
      return cal.deadline(new Date(start).getTime(), workingDays, heldMinutes);
    },
    async addWorkingMinutes({ datetime, minutes }) {
      log.push(['add', minutes]);
      return cal.advance(new Date(datetime).getTime(), minutes);
    },
  };
};
const snapshot = (over) => ({ officeId: 'o', days: 0, hours: 0, minutes: 0, heldMinutes: 0, ...over });
const run = (over, start, end, log) => computeCompliance(fakeCore(log), snapshot({ ...over, startedAt: new Date(at(...start)), endedAt: new Date(at(...end)) }));

describe('TC4-TXN-031..033: days part = 0 (hours/minutes only)', () => {
  it('1 hour standard: Tue 10:00 to 10:45 is compliant 15 minutes early', async () => {
    const log = [];
    assert.deepEqual(await run({ hours: 1 }, ['2026-10-06', '10:00'], ['2026-10-06', '10:45'], log), { elapsed: 45, isCompliant: true, variance: -15 });
    assert.deepEqual(log.map((l) => l[0]), ['wm'], 'only the working minutes are asked for');
  });

  it('completed exactly at the limit is compliant (variance 0); one minute more is a breach', async () => {
    assert.deepEqual(await run({ hours: 1 }, ['2026-10-06', '10:00'], ['2026-10-06', '11:00']), { elapsed: 60, isCompliant: true, variance: 0 });
    assert.deepEqual(await run({ hours: 1 }, ['2026-10-06', '10:00'], ['2026-10-06', '11:01']), { elapsed: 61, isCompliant: false, variance: 1 });
  });

  it('overnight: only working minutes count (Tue 18:30 to Wed 08:30 = 60)', async () => {
    assert.deepEqual(await run({ hours: 1, minutes: 30 }, ['2026-10-06', '18:30'], ['2026-10-07', '08:30']), { elapsed: 60, isCompliant: true, variance: -30 });
  });

  it('held time is taken off: 75 minutes in the office with 20 held = 55 elapsed', async () => {
    assert.deepEqual(await run({ hours: 1, heldMinutes: 20 }, ['2026-10-06', '10:00'], ['2026-10-06', '11:15']), { elapsed: 55, isCompliant: true, variance: -5 });
  });

  it('a transaction finished in the same instant it started has no working time (no question to Core is needed)', async () => {
    const log = [];
    const same = await run({ minutes: 5 }, ['2026-10-06', '10:00'], ['2026-10-06', '10:00'], log);
    assert.deepEqual(same, { elapsed: 0, isCompliant: true, variance: -5 });
    assert.equal(log.length, 0);
  });
});

describe('TC4-TXN-031..033: days part > 0 (deadline day, then hours/minutes, then hold time)', () => {
  // 3 working days from Tue 2026-10-06: Wed, Thu, Fri -> Fri 19:00 (the start day is not counted, the last is).
  it('3 working days: finished Fri 18:00 is compliant, 60 working minutes early', async () => {
    const log = [];
    const r = await run({ days: 3 }, ['2026-10-06', '10:00'], ['2026-10-09', '18:00'], log);
    assert.equal(r.isCompliant, true);
    assert.equal(r.variance, -60);
    assert.equal(r.elapsed, 540 + 660 + 660 + 600, 'Tue 10-19, Wed, Thu 08-19, Fri 08-18');
    assert.deepEqual(log.map((l) => l[0]).sort(), ['add', 'deadline', 'wm', 'wm']);
    assert.deepEqual(log.find((l) => l[0] === 'deadline'), ['deadline', 3, 0], 'the first deadline is asked with held minutes 0');
    assert.deepEqual(log.find((l) => l[0] === 'add'), ['add', 0], 'nothing to add: 0 hours, 0 minutes, 0 held');
  });

  it('exactly at the deadline minute: compliant, variance 0 (TC4-TXN-032)', async () => {
    const r = await run({ days: 3 }, ['2026-10-06', '10:00'], ['2026-10-09', '19:00']);
    assert.equal(r.isCompliant, true);
    assert.equal(r.variance, 0);
  });

  it('after the deadline: a breach, late by the working minutes after the deadline (Sat 08:00-10:00 = 120)', async () => {
    const r = await run({ days: 3 }, ['2026-10-06', '10:00'], ['2026-10-10', '10:00']);
    assert.equal(r.isCompliant, false);
    assert.equal(r.variance, 120);
  });

  it('mixed standard (C21): 1 working day + 4 hours 30 minutes, started Fri 09:00 -> deadline Tue 12:30', async () => {
    const standard = { days: 1, hours: 4, minutes: 30 };
    const start = ['2026-10-09', '09:00'];
    // The next working day after Fri is Sat (closes 17:00); then 270 working minutes: Sun and Mon are closed, Tue 08:00 + 270 = 12:30.
    const onTime = await run(standard, start, ['2026-10-13', '12:30']);
    assert.deepEqual([onTime.isCompliant, onTime.variance], [true, 0]);
    const late = await run(standard, start, ['2026-10-13', '12:31']);
    assert.deepEqual([late.isCompliant, late.variance], [false, 1]);
    const early = await run(standard, start, ['2026-10-13', '10:00']);
    assert.deepEqual([early.isCompliant, early.variance], [true, -150]);
  });

  it('hold time moves the deadline: the same mixed standard with 60 held minutes allows until Tue 13:30', async () => {
    const standard = { days: 1, hours: 4, minutes: 30, heldMinutes: 60 };
    const log = [];
    const r = await run(standard, ['2026-10-09', '09:00'], ['2026-10-13', '13:30'], log);
    assert.deepEqual([r.isCompliant, r.variance], [true, 0]);
    assert.deepEqual(log.find((l) => l[0] === 'add'), ['add', 330], 'hours*60 + minutes + held');
    const late = await run(standard, ['2026-10-09', '09:00'], ['2026-10-13', '13:31']);
    assert.deepEqual([late.isCompliant, late.variance], [false, 1]);
  });

  it('elapsed is working minutes from start to end minus held, whatever the standard says', async () => {
    const r = await run({ days: 3, heldMinutes: 100 }, ['2026-10-06', '10:00'], ['2026-10-07', '12:00']);
    // Tue 10:00-19:00 = 540, Wed 08:00-12:00 = 240 -> 780, minus 100 held.
    assert.equal(r.elapsed, 680);
  });
});
