import {
  RangeError_,
  addDays,
  businessDayKey,
  dayBounds,
  dayKeys,
  resolveRange,
  startOfBusinessDay,
  startOfBusinessWeek,
} from './business-time.js';

const IST = 'Asia/Kolkata'; // UTC+05:30, no DST
const CAIRO = 'Africa/Cairo';
const NY = 'America/New_York';

describe('business time', () => {
  it('buckets by the business zone, not by UTC', () => {
    // 20:00 UTC on the 10th is already 01:30 on the 11th in Kolkata
    const t = new Date('2027-03-10T20:00:00Z');
    expect(businessDayKey(t, 'UTC')).toBe('2027-03-10');
    expect(businessDayKey(t, IST)).toBe('2027-03-11');
    expect(startOfBusinessDay(t, IST).toISOString()).toBe(
      '2027-03-10T18:30:00.000Z',
    );
  });

  it('day bounds are [local midnight, next local midnight)', () => {
    const b = dayBounds('2027-03-11', IST);
    expect(b.start.toISOString()).toBe('2027-03-10T18:30:00.000Z');
    expect(b.end.toISOString()).toBe('2027-03-11T18:30:00.000Z');
  });

  it('handles DST days (23 / 25 hour days)', () => {
    const spring = dayBounds('2027-03-14', NY); // clocks go forward
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(
      23,
    );
    const autumn = dayBounds('2027-11-07', NY); // clocks go back
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(
      25,
    );
    expect(businessDayKey(new Date('2027-07-01T22:30:00Z'), CAIRO)).toBe(
      '2027-07-02',
    );
  });

  it('weeks start on Monday in the business zone', () => {
    // Wednesday 2027-03-10 → Monday 2027-03-08 00:00 IST
    expect(
      startOfBusinessWeek(new Date('2027-03-10T05:00:00Z'), IST).toISOString(),
    ).toBe('2027-03-07T18:30:00.000Z');
    // Sunday late UTC is already Monday in Kolkata
    expect(
      startOfBusinessWeek(new Date('2027-03-14T20:00:00Z'), IST).toISOString(),
    ).toBe('2027-03-14T18:30:00.000Z');
  });

  it('adds days and lists keys', () => {
    expect(addDays('2027-02-27', 2)).toBe('2027-03-01');
    expect(dayKeys('2027-03-01', '2027-03-03')).toEqual([
      '2027-03-01',
      '2027-03-02',
      '2027-03-03',
    ]);
  });
});

describe('resolveRange', () => {
  const now = new Date('2027-03-10T10:00:00Z');
  const limits = { defaultDays: 30, maxDays: 92 };
  it('defaults to the last N days up to now', () => {
    const r = resolveRange({}, now, IST, limits);
    expect(r.to).toEqual(now);
    expect(r.from.toISOString()).toBe('2027-02-08T10:00:00.000Z');
  });
  it('plain dates cover whole business days, `to` inclusive', () => {
    const r = resolveRange(
      { from: '2027-03-01', to: '2027-03-02' },
      now,
      IST,
      limits,
    );
    expect(r.from.toISOString()).toBe('2027-02-28T18:30:00.000Z');
    expect(r.to.toISOString()).toBe('2027-03-02T18:30:00.000Z');
  });
  it('rejects inverted, oversized and invalid ranges', () => {
    expect(() =>
      resolveRange({ from: '2027-03-05', to: '2027-03-01' }, now, IST, limits),
    ).toThrow(RangeError_);
    expect(() =>
      resolveRange({ from: '2026-01-01', to: '2027-03-01' }, now, IST, limits),
    ).toThrow(/limited to 92/);
    expect(() => resolveRange({ from: 'garbage' }, now, IST, limits)).toThrow(
      RangeError_,
    );
  });
});
