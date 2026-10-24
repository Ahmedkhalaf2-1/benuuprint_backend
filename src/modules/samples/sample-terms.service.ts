import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateTermsDto,
  RecordTermsAcceptanceDto,
  TermsResponseDto,
} from './dto/sample-spec.dto.js';
import type { SampleTermsAcceptanceDto } from './dto/sample.dto.js';
import { SAMPLE_TERMS_CODE } from './sample-workflow.service.js';

type TermsRow = Prisma.TermsVersionGetPayload<object>;
const toTerms = (t: TermsRow): TermsResponseDto => ({
  id: t.id,
  code: t.code,
  version: t.version,
  title: t.title,
  content: t.content,
  effectiveAt: t.effectiveAt,
  isActive: t.isActive,
  createdAt: t.createdAt,
});

@Injectable()
export class SampleTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- terms versions ------------------------------------------------------------

  async list(code?: string): Promise<TermsResponseDto[]> {
    const rows = await this.prisma.termsVersion.findMany({
      where: { code },
      orderBy: [{ code: 'asc' }, { version: 'desc' }],
    });
    return rows.map(toTerms);
  }

  async get(id: string): Promise<TermsResponseDto> {
    const row = await this.prisma.termsVersion.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Terms version not found');
    return toTerms(row);
  }

  /** Publishes the next version of a terms document. The text can never be edited afterwards. */
  async create(
    dto: CreateTermsDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TermsResponseDto> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        const latest = await tx.termsVersion.aggregate({
          where: { code: dto.code },
          _max: { version: true },
        });
        const created = await tx.termsVersion.create({
          data: {
            code: dto.code,
            version: (latest._max.version ?? 0) + 1,
            title: dto.title,
            content: dto.content,
            createdByUserId: actor.id,
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.TERMS_CREATED,
            entityType: 'TermsVersion',
            entityId: created.id,
            metadata: {
              code: created.code,
              version: created.version,
              title: created.title,
            },
            meta,
          },
          tx,
        );
        if (dto.activate) return this.activateIn(tx, created, actor, meta);
        return created;
      },
      { isolationLevel: 'Serializable' },
    );
    return toTerms(row);
  }

  async activate(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TermsResponseDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const terms = await tx.termsVersion.findUnique({ where: { id } });
      if (!terms) throw new NotFoundException('Terms version not found');
      if (terms.isActive) return terms;
      return this.activateIn(tx, terms, actor, meta);
    });
    return toTerms(row);
  }

  async deactivate(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TermsResponseDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const terms = await tx.termsVersion.findUnique({ where: { id } });
      if (!terms) throw new NotFoundException('Terms version not found');
      if (!terms.isActive) return terms;
      const updated = await tx.termsVersion.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.TERMS_DEACTIVATED,
          entityType: 'TermsVersion',
          entityId: id,
          metadata: { code: terms.code, version: terms.version },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toTerms(row);
  }

  // ---- acceptance -----------------------------------------------------------------

  /**
   * Staff-recorded acceptance on behalf of the customer. This is explicitly NOT
   * a customer-authenticated acceptance: the mode, the recording staff member,
   * the evidence note and the request origin are all stored. Once customers can
   * sign in, they will record CUSTOMER_AUTHENTICATED acceptances themselves.
   */
  async recordAcceptance(
    sampleId: string,
    dto: RecordTermsAcceptanceDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SampleTermsAcceptanceDto> {
    const sample = await this.prisma.sample.findUnique({
      where: { id: sampleId },
    });
    if (!sample) throw new NotFoundException('Sample not found');
    if (sample.archivedAt) throw new ConflictException('Sample is archived');
    if (sample.status !== 'DRAFT') {
      throw new ConflictException(
        'Terms must be accepted while the sample is a DRAFT',
      );
    }
    const terms = dto.termsVersionId
      ? await this.prisma.termsVersion.findUnique({
          where: { id: dto.termsVersionId },
        })
      : await this.prisma.termsVersion.findFirst({
          where: { code: SAMPLE_TERMS_CODE, isActive: true },
        });
    if (!terms)
      throw new BadRequestException(
        'There is no active sample terms version to accept',
      );
    if (!terms.isActive)
      throw new ConflictException('This terms version is no longer active');
    const existing = await this.prisma.sampleTermsAcceptance.findUnique({
      where: {
        sampleId_termsVersionId: { sampleId, termsVersionId: terms.id },
      },
    });
    if (existing)
      throw new ConflictException(
        'These terms were already accepted for this sample',
      );

    const acceptance = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sampleTermsAcceptance.create({
        data: {
          sampleId,
          termsVersionId: terms.id,
          mode: 'STAFF_RECORDED_ON_BEHALF',
          acceptedByCustomerId: sample.customerId,
          recordedByStaffUserId: actor.id,
          sourceNote: dto.sourceNote,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SAMPLE_TERMS_ACCEPTED,
          entityType: 'Sample',
          entityId: sampleId,
          metadata: {
            sampleNumber: sample.sampleNumber,
            termsCode: terms.code,
            termsVersion: terms.version,
            mode: 'STAFF_RECORDED_ON_BEHALF',
            sourceNote: dto.sourceNote,
          },
          meta,
        },
        tx,
      );
      return created;
    });
    return {
      id: acceptance.id,
      termsVersionId: terms.id,
      code: terms.code,
      version: terms.version,
      title: terms.title,
      mode: acceptance.mode,
      sourceNote: acceptance.sourceNote,
      acceptedAt: acceptance.acceptedAt,
    };
  }

  /**
   * Acceptance by the authenticated portal customer themselves (CUSTOMER_AUTHENTICATED). The customer is
   * identified by the session, never by the request; the staff recording fields stay empty.
   */
  async recordCustomerAcceptance(
    sampleId: string,
    customerId: string,
    termsVersionId: string | undefined,
    meta: RequestMeta,
  ): Promise<SampleTermsAcceptanceDto> {
    const sample = await this.prisma.sample.findFirst({
      where: { id: sampleId, customerId },
    });
    if (!sample) throw new NotFoundException('Sample not found');
    if (sample.archivedAt) throw new ConflictException('Sample is archived');
    if (sample.status !== 'DRAFT') {
      throw new ConflictException(
        'Terms must be accepted while the request is a draft',
      );
    }
    const terms = termsVersionId
      ? await this.prisma.termsVersion.findUnique({
          where: { id: termsVersionId },
        })
      : await this.prisma.termsVersion.findFirst({
          where: { code: SAMPLE_TERMS_CODE, isActive: true },
        });
    if (!terms)
      throw new BadRequestException(
        'There is no active sample terms version to accept',
      );
    if (!terms.isActive || terms.code !== SAMPLE_TERMS_CODE)
      throw new ConflictException('This terms version is no longer active');
    const existing = await this.prisma.sampleTermsAcceptance.findUnique({
      where: {
        sampleId_termsVersionId: { sampleId, termsVersionId: terms.id },
      },
    });
    if (existing)
      throw new ConflictException(
        'These terms were already accepted for this request',
      );
    const acceptance = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sampleTermsAcceptance.create({
        data: {
          sampleId,
          termsVersionId: terms.id,
          mode: 'CUSTOMER_AUTHENTICATED',
          acceptedByCustomerId: customerId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
      await this.audit.record(
        {
          actorCustomerId: customerId,
          action: AuditAction.SAMPLE_TERMS_ACCEPTED,
          entityType: 'Sample',
          entityId: sampleId,
          metadata: {
            sampleNumber: sample.sampleNumber,
            termsCode: terms.code,
            termsVersion: terms.version,
            mode: 'CUSTOMER_AUTHENTICATED',
          },
          meta,
        },
        tx,
      );
      return created;
    });
    return {
      id: acceptance.id,
      termsVersionId: terms.id,
      code: terms.code,
      version: terms.version,
      title: terms.title,
      mode: acceptance.mode,
      sourceNote: null,
      acceptedAt: acceptance.acceptedAt,
    };
  }

  /** At most one version per code is active (partial unique index); switch atomically. */
  private async activateIn(
    tx: Prisma.TransactionClient,
    terms: TermsRow,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TermsRow> {
    await tx.termsVersion.updateMany({
      where: { code: terms.code, isActive: true },
      data: { isActive: false },
    });
    const updated = await tx.termsVersion.update({
      where: { id: terms.id },
      data: { isActive: true },
    });
    await this.audit.record(
      {
        actorUserId: actor.id,
        action: AuditAction.TERMS_ACTIVATED,
        entityType: 'TermsVersion',
        entityId: terms.id,
        metadata: { code: terms.code, version: terms.version },
        meta,
      },
      tx,
    );
    return updated;
  }
}
