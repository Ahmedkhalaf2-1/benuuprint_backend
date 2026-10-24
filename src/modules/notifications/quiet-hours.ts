import {
  localInstant,
  localParts,
  addDays,
  businessDayKey,
  parseDayKey,
} from '../management/pure/business-time.js';

export interface QuietHours {
  /** Minutes after local midnight. */
  start: number;
  end: number;
}

export function parseQuietHours(
  start: string | null,
  end: string | null,
): QuietHours | null {
  if (!start || !end) return null;
  const m = (v: string) => {
    const [h, mi] = v.split(':').map(Number);
    return h! * 60 + mi!;
  };
  const q = { start: m(start), end: m(end) };
  return q.start === q.end ? null : q;
}

/** True when `at` (in `tz`) falls inside the quiet window; windows may cross midnight (21:00 → 08:00). */
export function inQuietHours(q: QuietHours, at: Date, tz: string): boolean {
  const p = localParts(at, tz);
  const minute = p.hour * 60 + p.minute;
  return q.start < q.end
    ? minute >= q.start && minute < q.end
    : minute >= q.start || minute < q.end;
}

/** The instant the quiet window ends (the next local `end` time at or after `at`). Null when not quiet. */
export function quietHoursEnd(
  q: QuietHours,
  at: Date,
  tz: string,
): Date | null {
  if (!inQuietHours(q, at, tz)) return null;
  const p = localParts(at, tz);
  const minute = p.hour * 60 + p.minute;
  const today = businessDayKey(at, tz);
  // crossing midnight and still before midnight → ends tomorrow; otherwise ends today
  const endDay =
    q.start > q.end && minute >= q.start ? addDays(today, 1) : today;
  const d = parseDayKey(endDay);
  return localInstant(
    d.year,
    d.month,
    d.day,
    Math.floor(q.end / 60),
    q.end % 60,
    tz,
  );
}
