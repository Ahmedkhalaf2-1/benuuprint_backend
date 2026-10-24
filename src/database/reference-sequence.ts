import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

export type ReferencePrefix =
  | 'CUS'
  | 'BRD'
  | 'FAB'
  | 'PAT'
  | 'SMP'
  | 'QTN'
  | 'PAY'
  | 'JOB'
  | 'ORD'
  | 'BAT'
  | 'TPK';

/** Anything that can run a tagged raw query: PrismaClient or a transaction client. */
interface RawClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

/**
 * Atomically allocate the next number for a prefix and format it (CUS-000001).
 *
 * A single INSERT .. ON CONFLICT DO UPDATE .. RETURNING takes a row lock, so
 * concurrent callers are serialised and can never receive the same value. Call
 * it inside the creating transaction: a rollback also rolls back the increment,
 * leaving no gaps. Add new prefixes (SMP, ORD, JOB, QTN) by extending the type.
 */
export async function nextReference(
  client: RawClient,
  prefix: string,
): Promise<string> {
  const rows = await client.$queryRaw<{ last_value: number }[]>`
    INSERT INTO reference_sequences (prefix, last_value, updated_at)
    VALUES (${prefix}, 1, now())
    ON CONFLICT (prefix)
    DO UPDATE SET last_value = reference_sequences.last_value + 1, updated_at = now()
    RETURNING last_value`;
  return `${prefix}-${String(rows[0]!.last_value).padStart(6, '0')}`;
}

@Injectable()
export class ReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  next(prefix: ReferencePrefix, tx: RawClient = this.prisma): Promise<string> {
    return nextReference(tx, prefix);
  }
}
