/**
 * Bounded exponential backoff: base × 2^(attempt − 1), capped. Attempt 1 is the first try, so after the
 * first failure the wait is `baseSeconds`, then 2×, 4× … never more than `maxSeconds`.
 */
export function backoffSeconds(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(baseSeconds * 2 ** exp, maxSeconds);
}

export const addSeconds = (d: Date, seconds: number) =>
  new Date(d.getTime() + seconds * 1000);
