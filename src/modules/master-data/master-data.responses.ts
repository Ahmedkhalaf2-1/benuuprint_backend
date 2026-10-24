import type { Prisma } from '../../generated/prisma/client.js';

/** Decimal -> fixed two-decimal string for JSON (never a float, stable formatting). */
export const decimal = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(2);
