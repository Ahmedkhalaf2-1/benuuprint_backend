import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  FactoryJobQrToken,
  Prisma,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';

type Client = PrismaService | Prisma.TransactionClient;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export interface QrIssue {
  token: string;
  url: string;
  qrSvg: string;
}

/**
 * QR identity of a factory job.
 *
 * The QR encodes `<app>/q/<token>`: an opaque 256-bit token derived with HMAC-SHA256 from the token row id and
 * a server secret. It contains no database id and cannot be guessed or derived from the job number. Only the
 * SHA-256 of the token is stored for lookup; the server can recompute the token of the ACTIVE row to reprint a
 * job card, nobody else can.
 *
 * A QR code is an IDENTIFIER, never a credential: resolving it needs a signed-in staff member, and what that
 * person sees or may do is decided by the usual assignment and permission checks. Rotation revokes the old
 * token (the printed card stops resolving); revoking leaves the job without one.
 */
@Injectable()
export class QrService {
  private readonly key: Buffer;
  private readonly baseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.key = createHmac('sha256', app.jwt.secret)
      .update('benue-print:qr-job-card:v1')
      .digest();
    this.baseUrl = (app.publicAppUrl ?? '').replace(/\/+$/, '');
  }

  private tokenFor(rowId: string): string {
    return createHmac('sha256', this.key).update(rowId).digest('base64url');
  }

  urlFor(token: string): string {
    return `${this.baseUrl}/q/${token}`;
  }

  async svg(url: string): Promise<string> {
    return QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
    });
  }

  private view(r: FactoryJobQrToken | null) {
    return r
      ? {
          active: !r.revokedAt,
          createdAt: r.createdAt,
          createdByUserId: r.createdByUserId,
          revokedAt: r.revokedAt,
          lastScannedAt: r.lastScannedAt,
          rotatedFromId: r.rotatedFromId,
        }
      : null;
  }

  async status(jobId: string) {
    await this.mustJob(this.prisma, jobId);
    const rows = await this.prisma.factoryJobQrToken.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
    const active = rows.find((r) => !r.revokedAt) ?? null;
    return {
      jobId,
      hasActiveToken: !!active,
      active: this.view(active),
      history: rows.map((r) => ({ id: r.id, ...this.view(r) })),
    };
  }

  private async mustJob(client: Client, jobId: string) {
    const job = await client.factoryJob.findUnique({
      where: { id: jobId },
      select: { id: true, jobNumber: true, status: true },
    });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  private async lock(tx: Prisma.TransactionClient, jobId: string) {
    await tx.$queryRaw`SELECT id FROM factory_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
  }

  private async issue(
    tx: Prisma.TransactionClient,
    jobId: string,
    actor: AuthUser,
    rotatedFromId: string | null,
  ) {
    // the id is chosen up front so the token (derived from it) and its hash exist before the row does:
    // the hash is immutable (trigger), so it must be right on insert
    const id = randomUUID();
    const token = this.tokenFor(id);
    const row = await tx.factoryJobQrToken.create({
      data: {
        id,
        jobId,
        tokenHash: sha256(token),
        createdByUserId: actor.id,
        rotatedFromId,
      },
    });
    return { row, token };
  }

  async generate(
    jobId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<QrIssue> {
    const token = await this.prisma.$transaction(async (tx) => {
      const job = await this.mustJob(tx, jobId);
      await this.lock(tx, jobId);
      if (job.status === 'CANCELLED')
        throw new ConflictException('A cancelled job cannot get a QR code');
      const active = await tx.factoryJobQrToken.findFirst({
        where: { jobId, revokedAt: null },
      });
      if (active)
        throw new ConflictException(
          'The job already has an active QR token; rotate it to replace it',
        );
      const { row, token } = await this.issue(tx, jobId, actor, null);
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QR_TOKEN_GENERATED,
          entityType: 'FactoryJob',
          entityId: jobId,
          metadata: { jobNumber: job.jobNumber, qrTokenId: row.id },
          meta,
        },
        tx,
      );
      return token;
    });
    const url = this.urlFor(token);
    return { token, url, qrSvg: await this.svg(url) };
  }

  async rotate(
    jobId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<QrIssue> {
    const token = await this.prisma.$transaction(async (tx) => {
      const job = await this.mustJob(tx, jobId);
      await this.lock(tx, jobId);
      const active = await tx.factoryJobQrToken.findFirst({
        where: { jobId, revokedAt: null },
      });
      if (active)
        await tx.factoryJobQrToken.update({
          where: { id: active.id },
          data: { revokedAt: new Date(), revokedByUserId: actor.id },
        });
      const { row, token } = await this.issue(
        tx,
        jobId,
        actor,
        active?.id ?? null,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QR_TOKEN_ROTATED,
          entityType: 'FactoryJob',
          entityId: jobId,
          metadata: {
            jobNumber: job.jobNumber,
            qrTokenId: row.id,
            replacedQrTokenId: active?.id ?? null,
          },
          meta,
        },
        tx,
      );
      return token;
    });
    const url = this.urlFor(token);
    return { token, url, qrSvg: await this.svg(url) };
  }

  async revoke(jobId: string, actor: AuthUser, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const job = await this.mustJob(tx, jobId);
      await this.lock(tx, jobId);
      const active = await tx.factoryJobQrToken.findFirst({
        where: { jobId, revokedAt: null },
      });
      if (!active)
        throw new ConflictException('The job has no active QR token');
      await tx.factoryJobQrToken.update({
        where: { id: active.id },
        data: { revokedAt: new Date(), revokedByUserId: actor.id },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QR_TOKEN_REVOKED,
          entityType: 'FactoryJob',
          entityId: jobId,
          metadata: { jobNumber: job.jobNumber, qrTokenId: active.id },
          meta,
        },
        tx,
      );
    });
    return this.status(jobId);
  }

  /** The URL of the job's ACTIVE QR code (to print on a card or a tech pack), or null. */
  async activeUrl(
    jobId: string,
    client: Client = this.prisma,
  ): Promise<string | null> {
    const active = await client.factoryJobQrToken.findFirst({
      where: { jobId, revokedAt: null },
      select: { id: true },
    });
    return active ? this.urlFor(this.tokenFor(active.id)) : null;
  }

  /** Token → job id, only for an active token. Null for anything else (unknown, revoked, rotated away). */
  async resolve(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = await this.prisma.factoryJobQrToken.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!row || row.revokedAt) return null;
    if (this.tokenFor(row.id) !== token) return null;
    await this.prisma.factoryJobQrToken
      .update({ where: { id: row.id }, data: { lastScannedAt: new Date() } })
      .catch(() => undefined);
    return row.jobId;
  }
}
