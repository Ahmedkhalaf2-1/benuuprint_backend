/**
 * Capacity vs demand. Deliberately simple and honest about its limits:
 *  - capacity is configured per department (optionally per stage definition) per effective-date range;
 *  - every calendar day counts as a working day (there is no working calendar yet);
 *  - demand is the REMAINING work of open stages, bucketed on the day the stage is due; stages that
 *    are overdue or have no due date count on `today`;
 *  - a day with no effective capacity has capacity = null and no utilization (never a made-up 0).
 */

export interface CapacityConfig {
  id: string;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  dailyCapacity: number;
}

export function effectiveOn<T extends CapacityConfig>(
  configs: T[],
  day: string,
): T | null {
  const hit = configs.filter(
    (c) =>
      c.active &&
      c.effectiveFrom <= day &&
      (!c.effectiveTo || c.effectiveTo >= day),
  );
  // latest start wins when ranges overlap (the service refuses overlaps; this keeps reads deterministic)
  hit.sort(
    (a, b) =>
      b.effectiveFrom.localeCompare(a.effectiveFrom) ||
      a.id.localeCompare(b.id),
  );
  return hit[0] ?? null;
}

export interface DayUtilization {
  date: string;
  demand: number;
  capacity: number | null;
  utilizationPercent: number | null;
  overloaded: boolean;
  remainingCapacity: number | null;
}

export function utilizationFor(
  day: string,
  demand: number,
  capacity: number | null,
): DayUtilization {
  if (capacity == null)
    return {
      date: day,
      demand,
      capacity: null,
      utilizationPercent: null,
      overloaded: false,
      remainingCapacity: null,
    };
  return {
    date: day,
    demand,
    capacity,
    utilizationPercent: Math.round((demand / capacity) * 1000) / 10,
    overloaded: demand > capacity,
    remainingCapacity: Math.max(capacity - demand, 0),
  };
}

/** The day a unit of demand is placed on. `null` = outside the requested window. */
export function demandDay(
  dueDay: string | null,
  today: string,
  lastDay: string,
): string | null {
  const day = !dueDay || dueDay < today ? today : dueDay;
  return day > lastDay ? null : day;
}
