/**
 * Business-time helpers. Every timestamp in the database is UTC; "today", "this week" and daily
 * buckets are calendar concepts of the factory, so they are computed in BUSINESS_TIMEZONE (an IANA
 * zone) and never in the server's own zone. Pure and DST-safe (no dependency on process.env.TZ).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(instant: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(instant))
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset of `tz` from UTC at `instant`, in milliseconds (local − UTC). */
function offsetMs(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the local calendar day y-m-d begins in `tz`. */
export function localMidnight(
  year: number,
  month: number,
  day: number,
  tz: string,
): Date {
  return localInstant(year, month, day, 0, 0, tz);
}

/** The UTC instant of local wall-clock time y-m-d hh:mm in `tz` (DST-aware; gaps resolve forward). */
export function localInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(guess), tz);
  let result = guess - first;
  const second = offsetMs(new Date(result), tz);
  if (second !== first) result = guess - second;
  return new Date(result);
}

export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' of the local calendar day containing `instant`. */
export function businessDayKey(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function parseDayKey(key: string): {
  year: number;
  month: number;
  day: number;
} {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y!, month: m!, day: d! };
}

export function addDays(key: string, days: number): string {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

/** [start, end) of a local calendar day as UTC instants. */
export function dayBounds(key: string, tz: string): { start: Date; end: Date } {
  const a = parseDayKey(key);
  const b = parseDayKey(addDays(key, 1));
  return {
    start: localMidnight(a.year, a.month, a.day, tz),
    end: localMidnight(b.year, b.month, b.day, tz),
  };
}

export function startOfBusinessDay(instant: Date, tz: string): Date {
  return dayBounds(businessDayKey(instant, tz), tz).start;
}

/** Weeks start on Monday. */
export function startOfBusinessWeek(instant: Date, tz: string): Date {
  const key = businessDayKey(instant, tz);
  const { year, month, day } = parseDayKey(key);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return dayBounds(addDays(key, -((dow + 6) % 7)), tz).start;
}

/** Local day keys from `fromKey` to `toKey` inclusive. */
export function dayKeys(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) out.push(k);
  return out;
}

export class RangeError_ extends Error {}

export interface ResolvedRange {
  from: Date;
  to: Date;
}

/**
 * `from` / `to` accept an ISO date-time or a plain date. A plain `from` means the start of that
 * business day, a plain `to` means the END of that business day (inclusive), both in `tz`.
 * Defaults: to = now, from = to − defaultDays. The span is capped so analytics stay bounded.
 */
export function resolveRange(
  input: { from?: string; to?: string },
  now: Date,
  tz: string,
  limits: { defaultDays: number; maxDays: number },
): ResolvedRange {
  const bound = (value: string, kind: 'from' | 'to'): Date => {
    if (DAY_KEY.test(value)) {
      const b = dayBounds(value, tz);
      if (Number.isNaN(b.start.getTime()))
        throw new RangeError_(`${kind} is not a valid date`);
      return kind === 'from' ? b.start : b.end;
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
      throw new RangeError_(`${kind} is not a valid date`);
    return d;
  };
  const to = input.to ? bound(input.to, 'to') : now;
  const from = input.from
    ? bound(input.from, 'from')
    : new Date(to.getTime() - limits.defaultDays * 86_400_000);
  if (from >= to) throw new RangeError_('from must be before to');
  if (to.getTime() - from.getTime() > limits.maxDays * 86_400_000)
    throw new RangeError_(
      `The date range is limited to ${limits.maxDays} days`,
    );
  return { from, to };
}

export const minutesBetween = (a: Date, b: Date): number =>
  Math.round((b.getTime() - a.getTime()) / 60_000);
