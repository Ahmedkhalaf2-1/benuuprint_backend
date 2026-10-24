import { demandDay, effectiveOn, utilizationFor } from './capacity.js';

const cfg = (
  id: string,
  from: string,
  to: string | null,
  cap: number,
  active = true,
) => ({
  id,
  effectiveFrom: from,
  effectiveTo: to,
  dailyCapacity: cap,
  active,
});

describe('capacity configuration by date', () => {
  const list = [
    cfg('a', '2030-01-01', '2030-01-31', 100),
    cfg('b', '2030-02-01', null, 150),
    cfg('c', '2030-01-10', '2030-01-12', 999, false),
  ];
  it('picks the range that covers the day, inclusive on both ends', () => {
    expect(effectiveOn(list, '2030-01-01')?.id).toBe('a');
    expect(effectiveOn(list, '2030-01-31')?.id).toBe('a');
    expect(effectiveOn(list, '2030-02-01')?.id).toBe('b');
    expect(effectiveOn(list, '2031-06-01')?.id).toBe('b'); // open-ended
  });
  it('nothing before the first range, and inactive rows never count', () => {
    expect(effectiveOn(list, '2029-12-31')).toBeNull();
    expect(effectiveOn(list, '2030-01-11')?.id).toBe('a');
  });
});

describe('utilization', () => {
  it('computes percent, overload and remaining', () => {
    expect(utilizationFor('d', 80, 100)).toMatchObject({
      utilizationPercent: 80,
      overloaded: false,
      remainingCapacity: 20,
    });
    expect(utilizationFor('d', 150, 100)).toMatchObject({
      utilizationPercent: 150,
      overloaded: true,
      remainingCapacity: 0,
    });
    expect(utilizationFor('d', 100, 100).overloaded).toBe(false);
    expect(utilizationFor('d', 1, 3).utilizationPercent).toBe(33.3);
  });
  it('does not pretend when capacity is unknown', () => {
    expect(utilizationFor('d', 50, null)).toMatchObject({
      capacity: null,
      utilizationPercent: null,
      overloaded: false,
      remainingCapacity: null,
    });
  });
  it('places demand: overdue and undated count today, beyond the window is dropped', () => {
    expect(demandDay(null, '2030-01-10', '2030-01-16')).toBe('2030-01-10');
    expect(demandDay('2030-01-05', '2030-01-10', '2030-01-16')).toBe(
      '2030-01-10',
    );
    expect(demandDay('2030-01-12', '2030-01-10', '2030-01-16')).toBe(
      '2030-01-12',
    );
    expect(demandDay('2030-01-20', '2030-01-10', '2030-01-16')).toBeNull();
  });
});
