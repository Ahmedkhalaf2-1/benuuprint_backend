import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../../common/enums/audit-actions.js';
import type {
  ActorRef,
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../../common/types/paginated.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  AssetsService,
  type UploadedFileInput,
} from '../../assets/assets.service.js';
import type { DownloadUrlResponseDto } from '../../assets/dto/asset.dto.js';
import { AuditService } from '../../audit/audit.service.js';
import { type CustomerAction } from '../commercial/customer-commercial.js';
import { CustomerCommercialService } from '../commercial/customer-commercial.service.js';
import type {
  CreateDecorationDto,
  CreateSampleAccessoryDto,
  CreateSampleComponentDto,
  UpdateDecorationDto,
  UpdateSampleAccessoryDto,
  UpdateSampleComponentDto,
} from '../../samples/dto/sample-spec.dto.js';
import type {
  SampleAccessoryDto,
  SampleComponentDto,
  SampleDecorationDto,
} from '../../samples/dto/sample.dto.js';
import { SampleSpecService } from '../../samples/sample-spec.service.js';
import { SampleTermsService } from '../../samples/sample-terms.service.js';
import {
  SAMPLE_TERMS_CODE,
  SampleWorkflowService,
} from '../../samples/sample-workflow.service.js';
import { SamplesService } from '../../samples/samples.service.js';
import type {
  AcceptCustomerTermsDto,
  CustomerActivityEventDto,
  CustomerCreateSampleDto,
  CustomerFileDto,
  CustomerMessageDto,
  CustomerSampleDetailDto,
  CustomerSampleListItemDto,
  CustomerTermsAcceptanceDto,
  CustomerTermsDto,
  CustomerUpdateSampleDto,
  CustomerUploadFileDto,
  ListCustomerSamplesQueryDto,
  SubmissionCheckDto,
} from '../dto/customer-sample.dto.js';
import {
  INTERNAL_STATUSES_FOR,
  NEXT_STEP,
  STATUS_LABEL,
  isCustomerEditable,
  byTime,
  projectActivity,
  projectPaymentEvents,
  toCustomerStatus,
  type CustomerSampleStatus,
} from './customer-sample-status.js';

const MAX_FILES_PER_SAMPLE = 25;

const listInclude = {
  brand: { select: { id: true, name: true } },
  productType: { select: { name: true } },
  fabric: { select: { name: true } },
  fabricColor: { select: { name: true } },
  statusHistory: {
    where: { action: 'request-changes' },
    select: { id: true },
    take: 1,
  },
  // facts that refine the customer status (a payment waiting for review, a sample sent back by the customer)
  payments: {
    where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } },
    select: { id: true },
    take: 1,
  },
  approvals: {
    where: { type: 'SAMPLE', status: 'REJECTED' },
    select: { id: true },
    take: 1,
  },
  factoryJobs: {
    where: {
      sourceType: 'SAMPLE_PRODUCTION',
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.SampleInclude;

/** In production again only because the customer sent the finished sample back and no new job exists yet. */
const REVISION_REQUESTED: Prisma.SampleWhereInput = {
  status: 'IN_PRODUCTION',
  approvals: { some: { type: 'SAMPLE', status: 'REJECTED' } },
  factoryJobs: {
    none: {
      sourceType: 'SAMPLE_PRODUCTION',
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
  },
};
const PENDING_PAYMENT: Prisma.SampleWhereInput = {
  payments: { some: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } },
};

const detailInclude = {
  ...listInclude,
  sampleSize: { select: { id: true, name: true } },
  patternVersion: {
    select: { id: true, pattern: { select: { name: true, fitType: true } } },
  },
  decorations: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      printMethod: { select: { id: true, name: true } },
      artwork: {
        select: {
          id: true,
          name: true,
          _count: {
            select: { versions: { where: { status: { not: 'REJECTED' } } } },
          },
        },
      },
    },
  },
  accessories: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { accessory: { select: { id: true, name: true } } },
  },
  components: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      componentOption: { select: { id: true, name: true, category: true } },
    },
  },
  termsAcceptances: { select: { termsVersionId: true } },
} satisfies Prisma.SampleInclude;

type ListRow = Prisma.SampleGetPayload<{ include: typeof listInclude }>;
type DetailRow = Prisma.SampleGetPayload<{ include: typeof detailInclude }>;

const asActor = (me: CustomerPrincipal): ActorRef => ({
  id: me.customerId,
  customer: true,
});

const statusOf = (s: ListRow) =>
  toCustomerStatus({
    status: s.status,
    holdPreviousStatus: s.holdPreviousStatus,
    changesRequested: s.statusHistory.length > 0,
    pendingPayment: s.payments.length > 0,
    revisionRequested: s.approvals.length > 0 && s.factoryJobs.length === 0,
  });

function toListItem(s: ListRow): CustomerSampleListItemDto {
  const status = statusOf(s);
  return {
    id: s.id,
    sampleNumber: s.sampleNumber,
    status,
    statusLabel: STATUS_LABEL[status],
    nextStep: NEXT_STEP[status],
    editable: isCustomerEditable(s.status) && !s.archivedAt,
    brand: s.brand,
    productName: s.productType?.name ?? s.customProductName,
    fabricName: s.fabric?.name ?? s.customFabricName,
    colorName: s.fabricColor?.name ?? s.customColorName,
    submittedAt: s.submittedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * Everything a customer does with their sample requests. Every lookup is scoped by the session's
 * customer id (a foreign id is a plain 404), the specification rules are the staff ones (same services),
 * and nothing internal (notes, assignments, QC, factory data, audit) ever reaches the projection.
 */
@Injectable()
export class CustomerSamplesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly samples: SamplesService,
    private readonly spec: SampleSpecService,
    private readonly workflow: SampleWorkflowService,
    private readonly terms: SampleTermsService,
    private readonly assets: AssetsService,
    private readonly audit: AuditService,
    private readonly commercial: CustomerCommercialService,
  ) {}

  // ---- reads ---------------------------------------------------------------------------------

  async list(
    me: CustomerPrincipal,
    query: ListCustomerSamplesQueryDto,
  ): Promise<Paginated<CustomerSampleListItemDto>> {
    const search = query.search?.trim();
    const statusFilter = query.status?.length
      ? { OR: query.status.map((s) => this.whereForStatus(s)) }
      : undefined;
    const where: Prisma.SampleWhereInput = {
      customerId: me.customerId,
      archivedAt: null,
      brandId: query.brandId,
      ...(statusFilter && { AND: [statusFilter] }),
      ...(search && {
        OR: [
          { sampleNumber: { contains: search, mode: 'insensitive' } },
          {
            brand: { is: { name: { contains: search, mode: 'insensitive' } } },
          },
          { customProductName: { contains: search, mode: 'insensitive' } },
          {
            productType: {
              is: { name: { contains: search, mode: 'insensitive' } },
            },
          },
        ],
      }),
    };
    const sorts: Record<string, Prisma.SampleOrderByWithRelationInput> = {
      newest: { createdAt: 'desc' },
      oldest: { createdAt: 'asc' },
      updated: { updatedAt: 'desc' },
      submitted: { submittedAt: { sort: 'desc', nulls: 'last' } },
      sampleNumber: { sampleNumber: 'asc' },
    };
    const [rows, total] = await Promise.all([
      this.prisma.sample.findMany({
        where,
        include: listInclude,
        orderBy: [sorts[query.sort]!, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.sample.count({ where }),
    ]);
    return paginated(rows.map(toListItem), query.page, query.pageSize, total);
  }

  async get(
    me: CustomerPrincipal,
    id: string,
  ): Promise<CustomerSampleDetailDto> {
    const [sample, activeTerms, files] = await Promise.all([
      this.prisma.sample.findFirst({
        where: { id, customerId: me.customerId, archivedAt: null },
        include: detailInclude,
      }),
      this.prisma.termsVersion.findFirst({
        where: { code: SAMPLE_TERMS_CODE, isActive: true },
        select: { id: true, version: true },
      }),
      this.listFiles(me.customerId, id),
    ]);
    if (!sample) throw new NotFoundException('Request not found');
    const accepted =
      !!activeTerms &&
      sample.termsAcceptances.some((t) => t.termsVersionId === activeTerms.id);
    const actions = await this.commercial.actionsFor(me, sample, {
      required: !!activeTerms,
      accepted,
    });
    return this.toDetail(sample, activeTerms, files, actions);
  }

  async submissionCheck(
    me: CustomerPrincipal,
    id: string,
  ): Promise<SubmissionCheckDto> {
    await this.owned(me, id);
    const problems = await this.workflow.submissionProblems(id);
    return { ready: problems.length === 0, problems };
  }

  async activity(
    me: CustomerPrincipal,
    id: string,
  ): Promise<CustomerActivityEventDto[]> {
    await this.owned(me, id);
    const rows = await this.prisma.sampleStatusHistory.findMany({
      where: { sampleId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        action: true,
        fromStatus: true,
        toStatus: true,
        reason: true,
        createdAt: true,
      },
    });
    const payments = await this.prisma.payment.findMany({
      where: { sampleId: id },
      select: {
        status: true,
        createdAt: true,
        verifiedAt: true,
        updatedAt: true,
        customerMessage: true,
      },
    });
    return [...projectActivity(rows), ...projectPaymentEvents(payments)].sort(
      byTime,
    );
  }

  /** Staff notes explicitly marked CUSTOMER_VISIBLE; internal notes are never selected. */
  async messages(
    me: CustomerPrincipal,
    id: string,
  ): Promise<CustomerMessageDto[]> {
    await this.owned(me, id);
    const notes = await this.prisma.sampleNote.findMany({
      where: { sampleId: id, visibility: 'CUSTOMER_VISIBLE', archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, content: true, createdAt: true },
    });
    return notes.map((n) => ({
      id: n.id,
      at: n.createdAt,
      from: 'Benue Print team',
      content: n.content,
    }));
  }

  // ---- create / edit / submit --------------------------------------------------------------

  async create(
    me: CustomerPrincipal,
    dto: CustomerCreateSampleDto,
    meta: RequestMeta,
  ): Promise<CustomerSampleDetailDto> {
    await this.assertOwnBrand(me, dto.brandId);
    const created = await this.samples.createFor(
      Object.assign({}, dto, { customerId: me.customerId }),
      asActor(me),
      meta,
    );
    return this.get(me, created.id);
  }

  async update(
    me: CustomerPrincipal,
    id: string,
    dto: CustomerUpdateSampleDto,
    meta: RequestMeta,
  ): Promise<CustomerSampleDetailDto> {
    await this.ownedDraft(me, id);
    if (dto.brandId) await this.assertOwnBrand(me, dto.brandId);
    await this.samples.update(id, dto, asActor(me), meta);
    return this.get(me, id);
  }

  async submit(
    me: CustomerPrincipal,
    id: string,
    meta: RequestMeta,
  ): Promise<CustomerSampleDetailDto> {
    await this.owned(me, id);
    await this.workflow.submitForCustomer(id, me.customerId, meta);
    return this.get(me, id);
  }

  // ---- specification parts -----------------------------------------------------------------

  async createDecoration(
    me: CustomerPrincipal,
    sampleId: string,
    dto: CreateDecorationDto,
    meta: RequestMeta,
  ): Promise<SampleDecorationDto> {
    await this.ownedDraft(me, sampleId);
    return this.spec.createDecoration(sampleId, dto, asActor(me), meta);
  }

  async updateDecoration(
    me: CustomerPrincipal,
    sampleId: string,
    id: string,
    dto: UpdateDecorationDto,
    meta: RequestMeta,
  ): Promise<SampleDecorationDto> {
    await this.ownedDraft(me, sampleId);
    await this.assertChild(
      this.prisma.sampleDecoration.findFirst({ where: { id, sampleId } }),
      'Decoration',
    );
    return this.spec.updateDecoration(id, dto, asActor(me), meta);
  }

  async removeDecoration(
    me: CustomerPrincipal,
    sampleId: string,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.ownedDraft(me, sampleId);
    await this.assertChild(
      this.prisma.sampleDecoration.findFirst({ where: { id, sampleId } }),
      'Decoration',
    );
    return this.spec.removeDecoration(id, asActor(me), meta);
  }

  async createAccessory(
    me: CustomerPrincipal,
    sampleId: string,
    dto: CreateSampleAccessoryDto,
    meta: RequestMeta,
  ): Promise<SampleAccessoryDto> {
    await this.ownedDraft(me, sampleId);
    return this.spec.createAccessory(sampleId, dto, asActor(me), meta);
  }

  async updateAccessory(
    me: CustomerPrincipal,
    sampleId: string,
    id: string,
    dto: UpdateSampleAccessoryDto,
    meta: RequestMeta,
  ): Promise<SampleAccessoryDto> {
    await this.ownedDraft(me, sampleId);
    await this.assertChild(
      this.prisma.sampleAccessory.findFirst({ where: { id, sampleId } }),
      'Accessory',
    );
    return this.spec.updateAccessory(id, dto, asActor(me), meta);
  }

  async removeAccessory(
    me: CustomerPrincipal,
    sampleId: string,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.ownedDraft(me, sampleId);
    await this.assertChild(
      this.prisma.sampleAccessory.findFirst({ where: { id, sampleId } }),
      'Accessory',
    );
    return this.spec.removeAccessory(id, asActor(me), meta);
  }

  async createComponent(
    me: CustomerPrincipal,
    sampleId: string,
    dto: CreateSampleComponentDto,
    meta: RequestMeta,
  ): Promise<SampleComponentDto> {
    await this.ownedDraft(me, sampleId);
    return this.spec.createComponent(sampleId, dto, asActor(me), meta);
  }

  async updateComponent(
    me: CustomerPrincipal,
    sampleId: string,
    id: string,
    dto: UpdateSampleComponentDto,
    meta: RequestMeta,
  ): Promise<SampleComponentDto> {
    await this.ownedDraft(me, sampleId);
    await this.assertChild(
      this.prisma.sampleComponent.findFirst({ where: { id, sampleId } }),
      'Component',
    );
    return this.spec.updateComponent(id, dto, asActor(me), meta);
  }

  async removeComponent(
    me: CustomerPrincipal,
    sampleId: string,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.ownedDraft(me, sampleId);
    await this.assertChild(
      this.prisma.sampleComponent.findFirst({ where: { id, sampleId } }),
      'Component',
    );
    return this.spec.removeComponent(id, asActor(me), meta);
  }

  // ---- terms ---------------------------------------------------------------------------------

  async activeTerms(): Promise<CustomerTermsDto> {
    const terms = await this.prisma.termsVersion.findFirst({
      where: { code: SAMPLE_TERMS_CODE, isActive: true },
      select: { id: true, version: true, title: true, content: true },
    });
    if (!terms) throw new NotFoundException('There are no active sample terms');
    return terms;
  }

  async acceptTerms(
    me: CustomerPrincipal,
    sampleId: string,
    dto: AcceptCustomerTermsDto,
    meta: RequestMeta,
  ): Promise<CustomerTermsAcceptanceDto> {
    const accepted = await this.terms.recordCustomerAcceptance(
      sampleId,
      me.customerId,
      dto.termsVersionId,
      meta,
    );
    return {
      termsVersionId: accepted.termsVersionId,
      version: accepted.version,
      acceptedAt: accepted.acceptedAt,
    };
  }

  // ---- files ---------------------------------------------------------------------------------

  async listFiles(
    customerId: string,
    sampleId: string,
  ): Promise<CustomerFileDto[]> {
    const rows = await this.prisma.assetAttachment.findMany({
      where: {
        sampleId,
        sample: { customerId },
        asset: { archivedAt: null },
        // the customer's own uploads, plus the files staff explicitly shared with them (default: staff-only)
        OR: [
          { asset: { uploadedByCustomerId: customerId } },
          { customerVisible: true },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: { asset: true },
    });
    return rows.map((a) => {
      const own = a.asset.uploadedByCustomerId === customerId;
      return {
        source: own ? ('YOU' as const) : ('BENUE_PRINT' as const),
        attachmentId: a.id,
        assetId: a.assetId,
        type: a.asset.type,
        originalName: a.asset.originalName,
        mimeType: a.asset.mimeType,
        sizeBytes: a.asset.sizeBytes,
        // staff-written descriptions may be internal: only the customer's own text is shown
        description: own ? a.asset.description : null,
        uploadedAt: a.createdAt,
      };
    });
  }

  async listOwnFiles(
    me: CustomerPrincipal,
    sampleId: string,
  ): Promise<CustomerFileDto[]> {
    await this.owned(me, sampleId);
    return this.listFiles(me.customerId, sampleId);
  }

  async uploadFile(
    me: CustomerPrincipal,
    sampleId: string,
    file: UploadedFileInput | undefined,
    dto: CustomerUploadFileDto,
    meta: RequestMeta,
  ): Promise<CustomerFileDto> {
    await this.ownedDraft(me, sampleId);
    if (dto.decorationId && dto.type !== 'ARTWORK') {
      throw new BadRequestException(
        'decorationId can only be used with type ARTWORK',
      );
    }
    if (dto.decorationId) {
      await this.assertChild(
        this.prisma.sampleDecoration.findFirst({
          where: { id: dto.decorationId, sampleId },
        }),
        'Decoration',
      );
    }
    const existing = await this.prisma.assetAttachment.count({
      where: { sampleId },
    });
    if (existing >= MAX_FILES_PER_SAMPLE) {
      throw new ConflictException(
        `A request can hold at most ${MAX_FILES_PER_SAMPLE} files`,
      );
    }

    const asset = await this.assets.uploadForCustomer(
      file,
      { type: dto.type, description: dto.description },
      me.customerId,
      meta,
    );
    const attachment = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${sampleId}::uuid FOR UPDATE`;
      const sample = await tx.sample.findUniqueOrThrow({
        where: { id: sampleId },
        select: { status: true },
      });
      if (!isCustomerEditable(sample.status))
        throw new ConflictException('This request can no longer be edited');
      const created = await tx.assetAttachment.create({
        data: { assetId: asset.id, sampleId },
      });
      if (dto.decorationId)
        await this.linkArtwork(
          tx,
          sampleId,
          dto.decorationId,
          asset.id,
          dto.description,
        );
      await this.audit.record(
        {
          actorCustomerId: me.customerId,
          action: AuditAction.CUSTOMER_SAMPLE_FILE_UPLOADED,
          entityType: 'Sample',
          entityId: sampleId,
          metadata: {
            assetId: asset.id,
            type: dto.type,
            decorationId: dto.decorationId ?? null,
          },
          meta,
        },
        tx,
      );
      return created;
    });
    return {
      source: 'YOU' as const,
      attachmentId: attachment.id,
      assetId: asset.id,
      type: asset.type,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      description: asset.description,
      uploadedAt: attachment.createdAt,
    };
  }

  async removeFile(
    me: CustomerPrincipal,
    sampleId: string,
    attachmentId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.ownedDraft(me, sampleId);
    const row = await this.ownFileRow(me, sampleId, attachmentId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${sampleId}::uuid FOR UPDATE`;
      const sample = await tx.sample.findUniqueOrThrow({
        where: { id: sampleId },
        select: { status: true },
      });
      if (!isCustomerEditable(sample.status))
        throw new ConflictException('This request can no longer be edited');
      const versions = await tx.artworkVersion.findMany({
        where: { assetId: row.assetId },
      });
      if (versions.some((v) => v.status !== 'DRAFT')) {
        throw new ConflictException(
          'This file is part of an artwork that is already under review',
        );
      }
      // artwork versions are append-only (never deleted): a removed file's version is retired as REJECTED,
      // and a placement left without any usable version is unlinked so the customer must supply one again
      for (const v of versions) {
        await tx.artworkVersion.update({
          where: { id: v.id },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
            rejectionReason: 'Removed by the customer',
          },
        });
        const usable = await tx.artworkVersion.count({
          where: { artworkId: v.artworkId, status: { not: 'REJECTED' } },
        });
        if (usable === 0) {
          await tx.sampleDecoration.updateMany({
            where: { artworkId: v.artworkId },
            data: { artworkId: null },
          });
        }
      }
      await tx.assetAttachment.delete({ where: { id: attachmentId } });
      await tx.asset.update({
        where: { id: row.assetId },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(
        {
          actorCustomerId: me.customerId,
          action: AuditAction.CUSTOMER_SAMPLE_FILE_REMOVED,
          entityType: 'Sample',
          entityId: sampleId,
          metadata: { assetId: row.assetId },
          meta,
        },
        tx,
      );
    });
  }

  /** A signed URL is only minted after the sample AND the file are proven to be the caller's. */
  async downloadUrl(
    me: CustomerPrincipal,
    sampleId: string,
    attachmentId: string,
    disposition: 'attachment' | 'inline' | undefined,
  ): Promise<DownloadUrlResponseDto> {
    await this.owned(me, sampleId);
    const row = await this.ownFileRow(me, sampleId, attachmentId, false);
    return this.assets.downloadUrl(row.assetId, disposition);
  }

  // ---- helpers -------------------------------------------------------------------------------

  /** 404 unless the sample exists, is not archived and belongs to the caller. */
  private async owned(me: CustomerPrincipal, id: string) {
    const sample = await this.prisma.sample.findFirst({
      where: { id, customerId: me.customerId, archivedAt: null },
      select: { id: true, status: true },
    });
    if (!sample) throw new NotFoundException('Request not found');
    return sample;
  }

  private async ownedDraft(me: CustomerPrincipal, id: string) {
    const sample = await this.owned(me, id);
    if (!isCustomerEditable(sample.status)) {
      throw new ConflictException(
        'This request has been submitted and can no longer be edited',
      );
    }
    return sample;
  }

  private async assertChild(
    lookup: Promise<unknown>,
    label: string,
  ): Promise<void> {
    if (!(await lookup)) throw new NotFoundException(`${label} not found`);
  }

  /** The client is never trusted for brand ownership: unknown, foreign and archived all look the same. */
  private async assertOwnBrand(
    me: CustomerPrincipal,
    brandId: string,
  ): Promise<void> {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, customerId: me.customerId, archivedAt: null },
      select: { id: true },
    });
    if (!brand) throw new BadRequestException(['brandId: brand not found']);
  }

  /** `ownOnly`: only files the customer uploaded (removal); otherwise also files staff shared (download). */
  private async ownFileRow(
    me: CustomerPrincipal,
    sampleId: string,
    attachmentId: string,
    ownOnly = true,
  ) {
    const row = await this.prisma.assetAttachment.findFirst({
      where: {
        id: attachmentId,
        sampleId,
        sample: { customerId: me.customerId },
        asset: { archivedAt: null },
        ...(ownOnly
          ? { asset: { uploadedByCustomerId: me.customerId, archivedAt: null } }
          : {
              OR: [
                { asset: { uploadedByCustomerId: me.customerId } },
                { customerVisible: true },
              ],
            }),
      },
    });
    if (!row) throw new NotFoundException('File not found');
    return row;
  }

  /** Artwork under the hood: a sample-owned Artwork with a DRAFT version per uploaded file. */
  private async linkArtwork(
    tx: Prisma.TransactionClient,
    sampleId: string,
    decorationId: string,
    assetId: string,
    notes: string | undefined,
  ): Promise<void> {
    const decoration = await tx.sampleDecoration.findFirstOrThrow({
      where: { id: decorationId, sampleId },
      include: { artwork: { select: { id: true, sampleId: true } } },
    });
    let artworkId =
      decoration.artwork?.sampleId === sampleId ? decoration.artwork.id : null;
    if (!artworkId) {
      const purpose =
        decoration.side === 'FRONT'
          ? 'FRONT_PRINT'
          : decoration.side === 'BACK'
            ? 'BACK_PRINT'
            : 'GENERAL_REFERENCE';
      const artwork = await tx.artwork.create({
        data: {
          sampleId,
          name: `${decoration.placement} artwork`.slice(0, 120),
          purpose,
        },
      });
      artworkId = artwork.id;
      await tx.sampleDecoration.update({
        where: { id: decorationId },
        data: { artworkId },
      });
    }
    const last = await tx.artworkVersion.aggregate({
      where: { artworkId },
      _max: { versionNumber: true },
    });
    await tx.artworkVersion.create({
      data: {
        artworkId,
        versionNumber: (last._max.versionNumber ?? 0) + 1,
        assetId,
        notes: notes ?? null,
      },
    });
  }

  private whereForStatus(
    status: CustomerSampleStatus,
  ): Prisma.SampleWhereInput {
    const internal = [...INTERNAL_STATUSES_FOR[status]];
    const direct: Prisma.SampleWhereInput = { status: { in: internal } };
    const held: Prisma.SampleWhereInput = {
      status: 'ON_HOLD',
      holdPreviousStatus: { in: internal },
    };
    if (status === 'DRAFT')
      return {
        status: 'DRAFT',
        statusHistory: { none: { action: 'request-changes' } },
      };
    if (status === 'CHANGES_REQUESTED')
      return {
        status: 'DRAFT',
        statusHistory: { some: { action: 'request-changes' } },
      };
    if (status === 'PAYMENT_UNDER_REVIEW')
      return { AND: [{ OR: [direct, held] }, PENDING_PAYMENT] };
    if (status === 'PAYMENT_REQUIRED')
      return { AND: [{ OR: [direct, held] }, { NOT: PENDING_PAYMENT }] };
    if (status === 'REVISION_REQUESTED') return REVISION_REQUESTED;
    if (status === 'IN_SAMPLE_PRODUCTION')
      return {
        OR: [
          { status: 'READY_FOR_PRODUCTION' },
          { AND: [{ status: 'IN_PRODUCTION' }, { NOT: REVISION_REQUESTED }] },
          held,
        ],
      };
    // a hold keeps the status it interrupted (a held request that never got a previous status counts as under review)
    return status === 'UNDER_REVIEW'
      ? { OR: [direct, held, { status: 'ON_HOLD', holdPreviousStatus: null }] }
      : { OR: [direct, held] };
  }

  private toDetail(
    s: DetailRow,
    activeTerms: { id: string; version: number } | null,
    files: CustomerFileDto[],
    allowedActions: CustomerAction[],
  ): CustomerSampleDetailDto {
    return Object.assign(toListItem(s), {
      revisionNumber: s.revisionNumber,
      productTypeId: s.productTypeId,
      customProductName: s.customProductName,
      customProductDescription: s.customProductDescription,
      fabricId: s.fabricId,
      customFabricName: s.customFabricName,
      customFabricDescription: s.customFabricDescription,
      fabricProvider: s.fabricProvider,
      gsm: s.gsm,
      fabricColorId: s.fabricColorId,
      customColorName: s.customColorName,
      customPantone: s.customPantone,
      customHex: s.customHex,
      size: s.sampleSize,
      fitMethod: s.fitMethod,
      pattern: s.patternVersion
        ? {
            patternVersionId: s.patternVersion.id,
            name: s.patternVersion.pattern.name,
            fitType: s.patternVersion.pattern.fitType,
          }
        : null,
      notes: s.notes,
      fitNotes: s.fitNotes,
      printNotes: s.printNotes,
      fabricNotes: s.fabricNotes,
      specialInstructions: s.specialInstructions,
      decorations: s.decorations.map((d) => ({
        id: d.id,
        printMethod: d.printMethod,
        placement: d.placement,
        side: d.side,
        width: d.width?.toFixed(2) ?? null,
        height: d.height?.toFixed(2) ?? null,
        unit: d.unit,
        colorCount: d.colorCount,
        notes: d.notes,
        artworkRequired: d.artworkRequired,
        artwork: d.artwork
          ? {
              id: d.artwork.id,
              name: d.artwork.name,
              versionCount: d.artwork._count.versions,
            }
          : null,
      })),
      accessories: s.accessories.map((a) => ({
        id: a.id,
        accessory: a.accessory,
        customName: a.customName,
        quantity: a.quantity,
        notes: a.notes,
      })),
      components: s.components.map((c) => ({
        id: c.id,
        componentOption: c.componentOption
          ? { id: c.componentOption.id, name: c.componentOption.name }
          : null,
        category: c.componentOption?.category ?? null,
        customName: c.customName,
        notes: c.notes,
      })),
      files,
      allowedActions,
      terms: {
        required: !!activeTerms,
        accepted:
          !!activeTerms &&
          s.termsAcceptances.some((t) => t.termsVersionId === activeTerms.id),
        activeTermsVersionId: activeTerms?.id ?? null,
        activeVersion: activeTerms?.version ?? null,
      },
    });
  }
}
