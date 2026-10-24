import {
  CALENDAR_TIME,
  NoWorkingTimeError,
  addWorkingMinutes,
  formatHHMM,
  isAlwaysOpen,
  isWorkingTime,
  nextWorkingTime,
  parseHHMM,
  workingClock,
  workingMinutesBetween,
  type DayHours,
  type WorkingSchedule,
} from './working-time.js';

const nine: DayHours = { start: 9 * 60, end: 17 * 60 };
/** Cairo-like week (Sun–Thu 09:00–17:00); Friday and Saturday off. Zone is just a parameter. */
const week = (
  tz: string,
  exceptions: [string, DayHours | null][] = [],
): WorkingSchedule => ({
  timezone: tz,
  weekly: [nine, nine, nine, nine, nine, null, null],
  exceptions: new Map(exceptions),
});
const CAIRO = 'Africa/Cairo'; // UTC+2 in winter (no DST in January)
const utc = (s: string) => new Date(s);

describe('working time', () => {
  // 2031-01-05 is a Sunday; 2031-01-09 a Thursday; 2031-01-10 a Friday; 2031-01-11 a Saturday
  const sch = week(CAIRO);

  it('a normal working day: [start, end) is working time', () => {
    expect(isWorkingTime(sch, utc('2031-01-05T07:00:00Z'))).toBe(true); // 09:00 local
    expect(isWorkingTime(sch, utc('2031-01-05T14:59:00Z'))).toBe(true); // 16:59
    expect(isWorkingTime(sch, utc('2031-01-05T15:00:00Z'))).toBe(false); // 17:00 excluded
    expect(isWorkingTime(sch, utc('2031-01-05T06:59:00Z'))).toBe(false); // 08:59
  });

  it('the weekend is not working time and next working time skips it', () => {
    expect(isWorkingTime(sch, utc('2031-01-10T10:00:00Z'))).toBe(false); // Friday
    expect(isWorkingTime(sch, utc('2031-01-11T10:00:00Z'))).toBe(false); // Saturday
    expect(
      nextWorkingTime(sch, utc('2031-01-09T16:00:00Z')).toISOString(),
    ).toBe('2031-01-12T07:00:00.000Z'); // Thu evening → Sun 09:00
    expect(
      nextWorkingTime(sch, utc('2031-01-05T10:00:00Z')).toISOString(),
    ).toBe('2031-01-05T10:00:00.000Z'); // already working
    expect(
      nextWorkingTime(sch, utc('2031-01-05T03:00:00Z')).toISOString(),
    ).toBe('2031-01-05T07:00:00.000Z'); // before opening
  });

  it('a holiday removes a working day; an exceptional day adds one; a shortened day shortens it', () => {
    const s = week(CAIRO, [
      ['2031-01-06', null], // Monday holiday
      ['2031-01-10', { start: 10 * 60, end: 14 * 60 }], // working Friday 10–14
      ['2031-01-07', { start: 9 * 60, end: 12 * 60 }], // short Tuesday
    ]);
    expect(isWorkingTime(s, utc('2031-01-06T09:00:00Z'))).toBe(false);
    expect(isWorkingTime(s, utc('2031-01-10T09:00:00Z'))).toBe(true); // 11:00 local
    expect(isWorkingTime(s, utc('2031-01-10T12:30:00Z'))).toBe(false); // 14:30 local
    expect(isWorkingTime(s, utc('2031-01-07T10:30:00Z'))).toBe(false); // 12:30 local on the short day
    expect(
      workingMinutesBetween(
        s,
        utc('2031-01-05T00:00:00Z'),
        utc('2031-01-09T23:59:00Z'),
      ),
    ).toBe(
      480 /*Sun*/ +
        0 /*Mon holiday*/ +
        180 /*Tue short*/ +
        480 /*Wed*/ +
        480 /*Thu*/,
    );
  });

  it('addWorkingMinutes runs inside, across and past working windows', () => {
    // 16:30 local Sunday + 60 min → 30 min today + 30 min Monday morning
    expect(
      addWorkingMinutes(sch, utc('2031-01-05T14:30:00Z'), 60).toISOString(),
    ).toBe('2031-01-06T07:30:00.000Z');
    // exactly to closing time
    expect(
      addWorkingMinutes(sch, utc('2031-01-05T13:00:00Z'), 120).toISOString(),
    ).toBe('2031-01-05T15:00:00.000Z');
    // across the weekend: Thursday 16:00 local + 120 → Thursday 1h, Sunday 1h
    expect(
      addWorkingMinutes(sch, utc('2031-01-09T14:00:00Z'), 120).toISOString(),
    ).toBe('2031-01-12T08:00:00.000Z');
    // starting outside working time: Friday noon + 30 → Sunday 09:30 local
    expect(
      addWorkingMinutes(sch, utc('2031-01-10T10:00:00Z'), 30).toISOString(),
    ).toBe('2031-01-12T07:30:00.000Z');
    // many days: 5 working days of 480 min from Sunday 09:00 → following Sunday 09:00
    expect(
      addWorkingMinutes(
        sch,
        utc('2031-01-05T07:00:00Z'),
        5 * 480,
      ).toISOString(),
    ).toBe('2031-01-09T15:00:00.000Z');
    expect(
      addWorkingMinutes(
        sch,
        utc('2031-01-05T07:00:00Z'),
        5 * 480 + 1,
      ).toISOString(),
    ).toBe('2031-01-12T07:01:00.000Z');
    expect(
      addWorkingMinutes(sch, utc('2031-01-05T10:00:00Z'), 0).toISOString(),
    ).toBe('2031-01-05T10:00:00.000Z');
  });

  it('workingMinutesBetween counts only working minutes and is 0 for reversed ranges', () => {
    expect(
      workingMinutesBetween(
        sch,
        utc('2031-01-05T07:00:00Z'),
        utc('2031-01-05T15:00:00Z'),
      ),
    ).toBe(480);
    expect(
      workingMinutesBetween(
        sch,
        utc('2031-01-05T00:00:00Z'),
        utc('2031-01-06T00:00:00Z'),
      ),
    ).toBe(480);
    // Thursday 16:00 local → Sunday 10:00 local: 60 + 60
    expect(
      workingMinutesBetween(
        sch,
        utc('2031-01-09T14:00:00Z'),
        utc('2031-01-12T08:00:00Z'),
      ),
    ).toBe(120);
    expect(
      workingMinutesBetween(
        sch,
        utc('2031-01-10T00:00:00Z'),
        utc('2031-01-11T23:00:00Z'),
      ),
    ).toBe(0);
    expect(
      workingMinutesBetween(
        sch,
        utc('2031-01-06T00:00:00Z'),
        utc('2031-01-05T00:00:00Z'),
      ),
    ).toBe(0);
  });

  it('is the inverse of addWorkingMinutes', () => {
    const from = utc('2031-01-08T11:17:00Z');
    for (const m of [1, 59, 300, 481, 2000]) {
      const to = addWorkingMinutes(sch, from, m);
      expect(workingMinutesBetween(sch, from, to)).toBe(m);
    }
  });

  it('works in the schedule zone, not UTC or the server zone', () => {
    // 22:30 UTC on Sunday is 00:30 on Monday in Cairo: Monday is a working day but 00:30 is before opening
    const t = utc('2031-01-05T22:30:00Z');
    expect(isWorkingTime(sch, t)).toBe(false);
    expect(nextWorkingTime(sch, t).toISOString()).toBe(
      '2031-01-06T07:00:00.000Z',
    );
    // the same instant in UTC-5 is still Sunday evening
    const ny = week('America/New_York');
    expect(isWorkingTime(ny, t)).toBe(false); // 17:30 local: after closing
    // Friday 22:30 UTC = Saturday 00:30 Cairo: not working either way, next is Sunday 09:00 local
    expect(
      nextWorkingTime(sch, utc('2031-01-10T22:30:00Z')).toISOString(),
    ).toBe('2031-01-12T07:00:00.000Z');
  });

  it('keeps wall-clock hours across a DST change', () => {
    // Cairo springs forward on the last Friday of April 2031 (the 25th): Sunday 27th is UTC+3
    const ny = week('America/New_York');
    expect(isWorkingTime(ny, utc('2031-03-10T13:00:00Z'))).toBe(true); // 09:00 EDT (clocks changed 9 March)
    expect(isWorkingTime(ny, utc('2031-03-10T12:59:00Z'))).toBe(false); // 08:59 EDT
    expect(
      workingMinutesBetween(
        ny,
        utc('2031-03-10T04:00:00Z'),
        utc('2031-03-11T04:00:00Z'),
      ),
    ).toBe(480);
  });

  it('an always-open schedule behaves like calendar time', () => {
    const open: WorkingSchedule = {
      timezone: 'UTC',
      weekly: Array.from({ length: 7 }, () => ({ start: 0, end: 1440 })),
      exceptions: new Map(),
    };
    expect(isAlwaysOpen(open)).toBe(true);
    const from = utc('2031-01-05T23:30:00Z');
    expect(addWorkingMinutes(open, from, 90).toISOString()).toBe(
      CALENDAR_TIME.add(from, 90).toISOString(),
    );
    expect(workingMinutesBetween(open, from, utc('2031-01-08T00:00:00Z'))).toBe(
      CALENDAR_TIME.between(from, utc('2031-01-08T00:00:00Z')),
    );
    expect(isAlwaysOpen(sch)).toBe(false);
  });

  it('a calendar with no working day cannot schedule anything', () => {
    const none: WorkingSchedule = {
      timezone: 'UTC',
      weekly: Array(7).fill(null),
      exceptions: new Map(),
    };
    expect(() => nextWorkingTime(none, utc('2031-01-05T10:00:00Z'))).toThrow(
      NoWorkingTimeError,
    );
    expect(() =>
      addWorkingMinutes(none, utc('2031-01-05T10:00:00Z'), 5),
    ).toThrow(NoWorkingTimeError);
    expect(
      workingMinutesBetween(
        none,
        utc('2031-01-05T10:00:00Z'),
        utc('2031-02-05T10:00:00Z'),
      ),
    ).toBe(0);
  });

  it('clock adapter and HH:MM helpers', () => {
    const c = workingClock(sch);
    expect(c.kind).toBe('WORKING');
    expect(c.add(utc('2031-01-05T14:30:00Z'), 60).toISOString()).toBe(
      '2031-01-06T07:30:00.000Z',
    );
    expect(c.isWorking(utc('2031-01-05T10:00:00Z'))).toBe(true);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('24:00')).toBe(1440);
    expect(() => parseHHMM('25:00')).toThrow();
    expect(() => parseHHMM('9:75')).toThrow();
    expect(formatHHMM(570)).toBe('09:30');
    expect(formatHHMM(1440)).toBe('24:00');
  });
});
