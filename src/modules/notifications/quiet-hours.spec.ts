import { inQuietHours, parseQuietHours, quietHoursEnd } from './quiet-hours.js';

const q = parseQuietHours('21:00', '08:00')!;
const CAIRO = 'Africa/Cairo'; // UTC+2 in January
const at = (s: string) => new Date(s);

describe('quiet hours', () => {
  it('parses and ignores empty / zero-length windows', () => {
    expect(q).toEqual({ start: 1260, end: 480 });
    expect(parseQuietHours(null, '08:00')).toBeNull();
    expect(parseQuietHours('', '')).toBeNull();
    expect(parseQuietHours('08:00', '08:00')).toBeNull();
  });

  it('a window across midnight is quiet in the evening and the early morning, in the business zone', () => {
    expect(inQuietHours(q, at('2031-01-05T18:59:00Z'), CAIRO)).toBe(false); // 20:59 local
    expect(inQuietHours(q, at('2031-01-05T19:00:00Z'), CAIRO)).toBe(true); // 21:00
    expect(inQuietHours(q, at('2031-01-05T22:30:00Z'), CAIRO)).toBe(true); // 00:30 next day
    expect(inQuietHours(q, at('2031-01-06T05:59:00Z'), CAIRO)).toBe(true); // 07:59
    expect(inQuietHours(q, at('2031-01-06T06:00:00Z'), CAIRO)).toBe(false); // 08:00
    expect(inQuietHours(q, at('2031-01-05T12:00:00Z'), 'UTC')).toBe(false);
  });

  it('a same-day window', () => {
    const lunch = parseQuietHours('12:00', '13:00')!;
    expect(inQuietHours(lunch, at('2031-01-05T10:30:00Z'), CAIRO)).toBe(true); // 12:30
    expect(inQuietHours(lunch, at('2031-01-05T11:00:00Z'), CAIRO)).toBe(false); // 13:00
  });

  it('reports when the window ends', () => {
    // 22:00 Cairo on the 5th → 08:00 Cairo on the 6th = 06:00Z
    expect(
      quietHoursEnd(q, at('2031-01-05T20:00:00Z'), CAIRO)?.toISOString(),
    ).toBe('2031-01-06T06:00:00.000Z');
    // 03:00 Cairo on the 6th → same morning
    expect(
      quietHoursEnd(q, at('2031-01-06T01:00:00Z'), CAIRO)?.toISOString(),
    ).toBe('2031-01-06T06:00:00.000Z');
    expect(quietHoursEnd(q, at('2031-01-05T12:00:00Z'), CAIRO)).toBeNull();
  });
});
