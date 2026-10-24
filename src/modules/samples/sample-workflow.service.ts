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
import { AuthContextService } from '../auth/auth-context.service.js';
import type { SampleDetailResponseDto } from './dto/sample.dto.js';
import { SamplesService } from './samples.service.js';
import { SampleTransitionsService } from './sample-transitions.service.js';
import {
  collectSubmissionProblems,
  type SubmissionInput,
} from './sample-submission.validator.js';
import { checkTransition, type SampleAction } from './sample-state-machine.js';

export const SAMPLE_TERMS_CODE = 'SAMPLE_TERMS';

@Injectable()
export class SampleWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: SampleTransitionsService,
    private readonly samples: SamplesService,
    private readonly audit: AuditService,
    private readonly authContext: AuthContextService,
  ) {}

  /** DRAFT → SUBMITTED, only if the specification is complete (all problems reported together). */
  async submit(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    return this.submitAs(id, { staff: actor }, meta);
  }

  /** Submit on behalf of the portal customer (the same validation, transition and events as staff). */
  submitForCustomer(
    id: string,
    customerId: string,
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    return this.submitAs(id, { customerId }, meta);
  }

  /** Everything still missing for submission, without changing anything (used by the customer portal). */
  async submissionProblems(id: string): Promise<string[]> {
    return collectSubmissionProblems(
      await this.loadSubmissionInput(this.prisma, id),
    );
  }

  private async submitAs(
    id: string,
    by: { staff: AuthUser } | { customerId: string },
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    const staff = 'staff' in by ? by.staff : null;
    const customerId = 'customerId' in by ? by.customerId : null;
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const sample = await tx.sample.findUnique({ where: { id } });
      if (!sample) throw new NotFoundException('Sample not found');
      if (sample.archivedAt) throw new ConflictException('Sample is archived');
      if (!checkTransition('submit', sample.status, null).ok) {
        throw new ConflictException(
          `Cannot submit a sample that is ${sample.status}`,
        );
      }
      const problems = collectSubmissionProblems(
        await this.loadSubmissionInput(tx, id),
      );
      if (problems.length) throw new BadRequestException(problems);

      await this.transitions.apply(tx, id, 'submit', {
        actor: staff,
        actorCustomerId: customerId,
        meta,
      });
      await this.audit.record(
        {
          actorUserId: staff?.id ?? null,
          actorCustomerId: customerId,
          action: AuditAction.SAMPLE_SUBMITTED,
          entityType: 'Sample',
          entityId: id,
          metadata: {
            sampleNumber: sample.sampleNumber,
            ...(customerId && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
    });
    return this.samples.get(id);
  }

  start = (id: string, actor: AuthUser, meta: RequestMeta) =>
    this.run(id, 'start-review', actor, meta);
  requestChanges = (
    id: string,
    reason: string,
    actor: AuthUser,
    meta: RequestMeta,
  ) => this.run(id, 'request-changes', actor, meta, reason);
  hold = (id: string, reason: string, actor: AuthUser, meta: RequestMeta) =>
    this.run(id, 'hold', actor, meta, reason);
  resume = (
    id: string,
    reason: string | undefined,
    actor: AuthUser,
    meta: RequestMeta,
  ) => this.run(id, 'resume', actor, meta, reason);
  reject = (id: string, reason: string, actor: AuthUser, meta: RequestMeta) =>
    this.run(id, 'reject', actor, meta, reason);
  cancel = (id: string, reason: string, actor: AuthUser, meta: RequestMeta) =>
    this.run(id, 'cancel', actor, meta, reason);
  /**
   * Manual stand-ins for sample-making without a factory job. While a live
   * sample-production job exists the factory drives these transitions instead.
   */
  private async assertNoLiveJob(id: string): Promise<void> {
    const job = await this.prisma.factoryJob.findFirst({
      where: { sampleId: id },
      select: { jobNumber: true },
    });
    if (job) {
      throw new ConflictException(
        `${job.jobNumber} exists for this sample: the factory job drives its production status (create a new job instead of using the manual stand-ins)`,
      );
    }
  }
  startProduction = async (id: string, actor: AuthUser, meta: RequestMeta) => {
    await this.assertNoLiveJob(id);
    return this.run(id, 'start-production', actor, meta);
  };
  finishProduction = async (id: string, actor: AuthUser, meta: RequestMeta) => {
    await this.assertNoLiveJob(id);
    return this.run(id, 'finish-production', actor, meta);
  };
  complete = (id: string, actor: AuthUser, meta: RequestMeta) =>
    this.run(id, 'complete', actor, meta);

  /** Commercial ownership only (not production assignment). */
  async assignSales(
    id: string,
    userId: string | null,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    if (userId) {
      const user = await this.prisma.user.findFirst({
        where: {
          id: userId,
          deletedAt: null,
          isActive: true,
          status: 'ACTIVE',
        },
      });
      if (!user)
        throw new BadRequestException('userId: active staff user not found');
      const access = await this.authContext.loadAccess(userId);
      if (!access.permissions.has('samples.manage')) {
        throw new BadRequestException(
          'userId: the user cannot manage samples (needs the samples.manage permission)',
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const sample = await tx.sample.findUnique({ where: { id } });
      if (!sample) throw new NotFoundException('Sample not found');
      if (sample.archivedAt) throw new ConflictException('Sample is archived');
      if (sample.assignedSalesUserId === userId) return;
      await tx.sample.update({
        where: { id },
        data: { assignedSalesUserId: userId },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SAMPLE_SALES_ASSIGNED,
          entityType: 'Sample',
          entityId: id,
          metadata: {
            sampleNumber: sample.sampleNumber,
            from: sample.assignedSalesUserId,
            to: userId,
          },
          meta,
        },
        tx,
      );
    });
    return this.samples.get(id);
  }

  private async run(
    id: string,
    action: SampleAction,
    actor: AuthUser,
    meta: RequestMeta,
    reason?: string,
  ): Promise<SampleDetailResponseDto> {
    await this.prisma.$transaction((tx) =>
      this.transitions.apply(tx, id, action, { actor, reason, meta }),
    );
    return this.samples.get(id);
  }

  private async loadSubmissionInput(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<SubmissionInput> {
    const s = await tx.sample.findUniqueOrThrow({
      where: { id },
      include: {
        customer: { select: { displayName: true, status: true } },
        brand: { select: { name: true, customerId: true, archivedAt: true } },
        productType: {
          select: { name: true, isActive: true, archivedAt: true },
        },
        fabric: {
          select: {
            name: true,
            isActive: true,
            archivedAt: true,
            minGsm: true,
            maxGsm: true,
          },
        },
        fabricColor: {
          select: {
            fabricId: true,
            isActive: true,
            isAvailable: true,
            archivedAt: true,
          },
        },
        sampleSize: { select: { isActive: true, archivedAt: true } },
        patternVersion: {
          select: {
            status: true,
            pattern: {
              select: { archivedAt: true, productTypeId: true, name: true },
            },
          },
        },
        decorations: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            printMethod: {
              select: {
                name: true,
                isActive: true,
                archivedAt: true,
                maxColors: true,
              },
            },
            artwork: {
              select: {
                name: true,
                archivedAt: true,
                brandId: true,
                sampleId: true,
                versions: { select: { status: true } },
              },
            },
          },
        },
        attachments: {
          include: { asset: { select: { type: true, archivedAt: true } } },
        },
        termsAcceptances: { select: { termsVersionId: true } },
      },
    });
    const activeTerms = await tx.termsVersion.findFirst({
      where: { code: SAMPLE_TERMS_CODE, isActive: true },
      select: { id: true, version: true },
    });
    return {
      sampleId: s.id,
      customerId: s.customerId,
      brandId: s.brandId,
      customer: s.customer,
      brand: s.brand,
      productTypeId: s.productTypeId,
      customProductName: s.customProductName,
      productType: s.productType,
      fabricId: s.fabricId,
      customFabricName: s.customFabricName,
      fabric: s.fabric,
      fabricColorId: s.fabricColorId,
      customColorName: s.customColorName,
      customPantone: s.customPantone,
      customHex: s.customHex,
      fabricColor: s.fabricColor,
      gsm: s.gsm,
      sampleSizeOptionId: s.sampleSizeOptionId,
      sampleSize: s.sampleSize,
      fitMethod: s.fitMethod,
      patternVersionId: s.patternVersionId,
      patternVersion: s.patternVersion,
      decorations: s.decorations.map((d) => ({
        placement: d.placement,
        colorCount: d.colorCount,
        artworkRequired: d.artworkRequired,
        artworkId: d.artworkId,
        printMethod: d.printMethod,
        artwork: d.artwork,
      })),
      attachments: s.attachments,
      acceptedTermsVersionIds: s.termsAcceptances.map((t) => t.termsVersionId),
      activeTerms,
    };
  }
}
