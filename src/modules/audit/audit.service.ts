import { Injectable } from '@nestjs/common';
import type { AuditActionValue } from '../../common/enums/audit-actions.js';
import type { RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

export interface AuditEntry {
  actorUserId?: string | null;
  /** Set (instead of actorUserId) when a portal customer caused the event. */
  actorCustomerId?: string | null;
  action: AuditActionValue;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
}

const SENSITIVE_KEY = /pass(word)?|token|secret|hash|authorization|cookie/i;

/** Defence in depth: strip anything that looks like a credential from metadata. */
export function sanitizeAuditMetadata(value: unknown): Prisma.InputJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditMetadata(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || SENSITIVE_KEY.test(key)) continue;
      out[key] = sanitizeAuditMetadata(item);
    }
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  return (value ?? null) as Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pass `tx` to write the audit row in the same transaction as the change it
   * describes (required for admin mutations).
   */
  async record(
    entry: AuditEntry,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorUserId: entry.actorUserId ?? null,
        actorCustomerId: entry.actorCustomerId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata
          ? sanitizeAuditMetadata(entry.metadata)
          : undefined,
        ipAddress: entry.meta?.ipAddress ?? null,
        userAgent: entry.meta?.userAgent ?? null,
      },
    });
  }
}
