import {
  addDays,
  businessDayKey,
  localInstant,
  parseDayKey,
} from './business-time.js';

/**
 * Working-time arithmetic over a factory calendar (weekly hours + dated exceptions) in an IANA zone.
 * Pure: stored timestamps stay UTC; the zone is only used to decide which instants are working time.
 *
 * Hours are minutes after local midnight (0 … 1440; an end of 1440 means "until midnight").
 * Working time is half-open: a window [09:00, 17:00) contains 09:00 and excludes 17:00.
 */

export interface DayHours {
  start: number;
  end: number;
}

export interface WorkingSchedule {
  timezone: string;
  /** Index 0 = Sunday … 6 = Saturday; null = not a working day. */
  weekly: readonly (DayHours | null)[];
  /** `YYYY-MM-DD` → hours (an exceptional / shortened day) or null (holiday). Wins over `weekly`. */
  exceptions: ReadonlyMap<string, DayHours | null>;
}

/** The search horizon: a schedule with no working day inside it is treated as "never working". */
const MAX_DAYS = 800;

export function weekdayOf(dayKey: string): number {
  const { year, month, day } = parseDayKey(dayKey);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function hoursFor(
  schedule: WorkingSchedule,
  dayKey: string,
): DayHours | null {
  if (schedule.exceptions.has(dayKey))
    return schedule.exceptions.get(dayKey) ?? null;
  return schedule.weekly[weekdayOf(dayKey)] ?? null;
}

function window(
  schedule: WorkingSchedule,
  dayKey: string,
): { start: Date; end: Date } | null {
  const h = hoursFor(schedule, dayKey);
  if (!h) return null;
  const { year, month, day } = parseDayKey(dayKey);
  const at = (m: number) =>
    m >= 1440
      ? (() => {
          const n = parseDayKey(addDays(dayKey, 1));
          return localInstant(n.year, n.month, n.day, 0, 0, schedule.timezone);
        })()
      : localInstant(
          year,
          month,
          day,
          Math.floor(m / 60),
          m % 60,
          schedule.timezone,
        );
  return { start: at(h.start), end: at(h.end) };
}

export class NoWorkingTimeError extends Error {
  constructor() {
    super('The working calendar has no working time within the search horizon');
  }
}

export function isWorkingTime(schedule: WorkingSchedule, at: Date): boolean {
  const w = window(schedule, businessDayKey(at, schedule.timezone));
  return (
    !!w && at.getTime() >= w.start.getTime() && at.getTime() < w.end.getTime()
  );
}

/** `at` itself when it is working time, otherwise the start of the next working window. */
export function nextWorkingTime(schedule: WorkingSchedule, at: Date): Date {
  let key = businessDayKey(at, schedule.timezone);
  for (let i = 0; i < MAX_DAYS; i++, key = addDays(key, 1)) {
    const w = window(schedule, key);
    if (!w) continue;
    if (at.getTime() < w.start.getTime()) return w.start;
    if (at.getTime() < w.end.getTime()) return at;
  }
  throw new NoWorkingTimeError();
}

/**
 * `from` + `minutes` of WORKING time. Counting starts at the next working moment, so adding to a
 * Saturday evening starts on Sunday morning. Adding 0 returns `from` unchanged.
 */
export function addWorkingMinutes(
  schedule: WorkingSchedule,
  from: Date,
  minutes: number,
): Date {
  if (minutes <= 0) return new Date(from);
  let remaining = minutes * 60_000;
  let cursor = from.getTime();
  let key = businessDayKey(from, schedule.timezone);
  for (let i = 0; i < MAX_DAYS; i++, key = addDays(key, 1)) {
    const w = window(schedule, key);
    if (!w) continue;
    const start = Math.max(cursor, w.start.getTime());
    const end = w.end.getTime();
    if (start >= end) continue;
    const room = end - start;
    if (remaining <= room) return new Date(start + remaining);
    remaining -= room;
  }
  throw new NoWorkingTimeError();
}

/** Working minutes in [a, b); 0 when b ≤ a. */
export function workingMinutesBetween(
  schedule: WorkingSchedule,
  a: Date,
  b: Date,
): number {
  if (b.getTime() <= a.getTime()) return 0;
  let total = 0;
  const lastKey = businessDayKey(b, schedule.timezone);
  let key = businessDayKey(a, schedule.timezone);
  for (let i = 0; i < MAX_DAYS && key <= lastKey; i++, key = addDays(key, 1)) {
    const w = window(schedule, key);
    if (!w) continue;
    const start = Math.max(a.getTime(), w.start.getTime());
    const end = Math.min(b.getTime(), w.end.getTime());
    if (end > start) total += end - start;
  }
  return Math.round(total / 60_000);
}

/** What the SLA / ETA code needs: either calendar time or working time. */
export interface BusinessClock {
  readonly kind: 'CALENDAR' | 'WORKING';
  add(from: Date, minutes: number): Date;
  between(a: Date, b: Date): number;
  /** First moment work can happen at or after `at`. */
  next(at: Date): Date;
  isWorking(at: Date): boolean;
}

export const CALENDAR_TIME: BusinessClock = {
  kind: 'CALENDAR',
  add: (from, minutes) => new Date(from.getTime() + minutes * 60_000),
  between: (a, b) =>
    b <= a ? 0 : Math.round((b.getTime() - a.getTime()) / 60_000),
  next: (at) => at,
  isWorking: () => true,
};

export function workingClock(schedule: WorkingSchedule): BusinessClock {
  return {
    kind: 'WORKING',
    add: (from, minutes) => addWorkingMinutes(schedule, from, minutes),
    between: (a, b) => workingMinutesBetween(schedule, a, b),
    next: (at) => nextWorkingTime(schedule, at),
    isWorking: (at) => isWorkingTime(schedule, at),
  };
}

/** True for a schedule that is open around the clock every day (equivalent to calendar time). */
export function isAlwaysOpen(schedule: WorkingSchedule): boolean {
  return (
    schedule.exceptions.size === 0 &&
    schedule.weekly.length === 7 &&
    schedule.weekly.every((d) => d && d.start === 0 && d.end === 1440)
  );
}

export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time ${value}`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 24 || Number(m[2]) > 59 || minutes > 1440)
    throw new Error(`Invalid time ${value}`);
  return minutes;
}

export function formatHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
