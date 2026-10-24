import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  ALLOWED_MIME_TYPES,
  sanitizeFileName,
  sniffFile,
} from './asset-file.js';
import type {
  AssetResponseDto,
  AssetTargetType,
  AttachAssetDto,
  AttachmentResponseDto,
  DownloadUrlResponseDto,
  ListAssetsQueryDto,
  UpdateAssetDto,
  UploadAssetDto,
} from './dto/asset.dto.js';

type AssetRow = Prisma.AssetGetPayload<object>;
type AttachmentRow = Prisma.AssetAttachmentGetPayload<object>;

export interface UploadedFileInput {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Target type -> attachment column (real foreign keys, no polymorphic type/id pair). */
const TARGET_COLUMN = {
  CUSTOMER: 'customerId',
  BRAND: 'brandId',
  FABRIC: 'fabricId',
  PATTERN_VERSION: 'patternVersionId',
  PRODUCT_TYPE: 'productTypeId',
  PRINT_METHOD: 'printMethodId',
  SAMPLE: 'sampleId',
  FACTORY_JOB: 'factoryJobId',
  JOB_STAGE: 'jobStageId',
  QC_INSPECTION: 'qcInspectionId',
} as const satisfies Record<AssetTargetType, keyof AttachmentRow>;

/** Asset types that make sense as sample attachments (payment proofs use Payment.proofAssetId). */
export const SAMPLE_ATTACHABLE_TYPES = [
  'REFERENCE',
  'MOCKUP',
  'SIZE_CHART',
  'ARTWORK',
  'OTHER',
] as const;

/** Shop-floor evidence: what staff may attach to jobs, stages and QC inspections. */
export const FACTORY_ATTACHABLE_TYPES = [
  'STAGE_PHOTO',
  'QC_PHOTO',
  'PATTERN_OUTPUT',
  'PRINT_PROOF',
  'PRODUCTION_REFERENCE',
  'OTHER',
] as const;
const FACTORY_TARGETS: readonly AssetTargetType[] = [
  'FACTORY_JOB',
  'JOB_STAGE',
  'QC_INSPECTION',
];

export function toAssetResponse(a: AssetRow): AssetResponseDto {
  return {
    id: a.id,
    type: a.type,
    originalName: a.originalName,
    description: a.description,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    checksum: a.checksum,
    uploadedByStaffUserId: a.uploadedByStaffUserId,
    createdAt: a.createdAt,
    archivedAt: a.archivedAt,
  };
}

function toAttachment(row: AttachmentRow): AttachmentResponseDto {
  for (const [targetType, column] of Object.entries(TARGET_COLUMN)) {
    const targetId = row[column as keyof AttachmentRow];
    if (typeof targetId === 'string') {
      return {
        id: row.id,
        assetId: row.assetId,
        targetType: targetType as AssetTargetType,
        targetId,
        createdAt: row.createdAt,
      };
    }
  }
  throw new Error(`Attachment ${row.id} has no target`);
}

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly maxFileBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.maxFileBytes =
      config.getOrThrow<AppConfig>('app').storage.maxFileBytes;
  }

  async upload(
    file: UploadedFileInput | undefined,
    dto: UploadAssetDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<AssetResponseDto> {
    return this.store(file, dto, { staffUserId: actor.id }, meta);
  }

  /** Customer-portal upload: same validation and private storage, attributed to the customer. */
  async uploadForCustomer(
    file: UploadedFileInput | undefined,
    dto: UploadAssetDto,
    customerId: string,
    meta: RequestMeta,
  ): Promise<AssetResponseDto> {
    return this.store(file, dto, { customerId }, meta);
  }

  private async store(
    file: UploadedFileInput | undefined,
    dto: UploadAssetDto,
    uploader: { staffUserId?: string; customerId?: string },
    meta: RequestMeta,
  ): Promise<AssetResponseDto> {
    if (!file)
      throw new BadRequestException(
        'A file is required (multipart field "file")',
      );
    if (file.size === 0 || file.buffer.length === 0) {
      throw new BadRequestException('The file is empty');
    }
    if (file.buffer.length > this.maxFileBytes) {
      throw new PayloadTooLargeException(
        `File exceeds the ${this.maxFileBytes} byte limit`,
      );
    }
    const sniffed = sniffFile(file.buffer);
    if (!sniffed) {
      throw new UnsupportedMediaTypeException(
        `Unsupported file content. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }

    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    // Random, server-generated key: no user input, no predictable URL.
    const storageKey = `assets/${now.getUTCFullYear()}/${month}/${randomUUID()}.${sniffed.extension}`;
    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.put(storageKey, file.buffer, {
      contentType: sniffed.mimeType,
    });
    try {
      const asset = await this.prisma.$transaction(async (tx) => {
        const created = await tx.asset.create({
          data: {
            type: dto.type,
            originalName: sanitizeFileName(file.originalname),
            description: dto.description,
            mimeType: sniffed.mimeType,
            sizeBytes: file.buffer.length,
            storageProvider: this.storage.providerName,
            storageKey,
            checksum,
            uploadedByStaffUserId: uploader.staffUserId ?? null,
            uploadedByCustomerId: uploader.customerId ?? null,
          },
        });
        await this.audit.record(
          {
            actorUserId: uploader.staffUserId ?? null,
            actorCustomerId: uploader.customerId ?? null,
            action: AuditAction.ASSET_UPLOADED,
            entityType: 'Asset',
            entityId: created.id,
            metadata: {
              type: created.type,
              originalName: created.originalName,
              mimeType: created.mimeType,
              sizeBytes: created.sizeBytes,
              checksum,
              ...(uploader.customerId && { via: 'customer_portal' }),
            },
            meta,
          },
          tx,
        );
        return created;
      });
      return toAssetResponse(asset);
    } catch (error) {
      await this.storage.delete(storageKey).catch((cleanupError: unknown) => {
        this.logger.error(
          `Failed to clean up orphaned object: ${String(cleanupError)}`,
        );
      });
      throw error;
    }
  }

  /**
   * Stores a document the SERVER generated (tech pack PDF). Same private storage, random key and checksum as
   * uploads; only PDFs are accepted here and the upload size limit does not apply (generated, bounded to 8 MB).
   */
  async storeGenerated(
    buffer: Buffer,
    input: { type: 'TECH_PACK'; originalName: string; description?: string },
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<{ id: string; checksum: string; sizeBytes: number }> {
    const sniffed = sniffFile(buffer);
    if (
      sniffed?.mimeType !== 'application/pdf' ||
      buffer.length === 0 ||
      buffer.length > 8 * 1024 * 1024
    )
      throw new BadRequestException(
        'Only PDF documents up to 8 MB can be generated',
      );
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const storageKey = `assets/${now.getUTCFullYear()}/${month}/${randomUUID()}.pdf`;
    const checksum = createHash('sha256').update(buffer).digest('hex');
    await this.storage.put(storageKey, buffer, {
      contentType: 'application/pdf',
    });
    try {
      const asset = await this.prisma.$transaction(async (tx) => {
        const created = await tx.asset.create({
          data: {
            type: input.type,
            originalName: sanitizeFileName(input.originalName),
            description: input.description,
            mimeType: 'application/pdf',
            sizeBytes: buffer.length,
            storageProvider: this.storage.providerName,
            storageKey,
            checksum,
            uploadedByStaffUserId: actor.id,
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.ASSET_UPLOADED,
            entityType: 'Asset',
            entityId: created.id,
            metadata: {
              type: created.type,
              originalName: created.originalName,
              mimeType: created.mimeType,
              sizeBytes: created.sizeBytes,
              checksum,
              generated: true,
            },
            meta,
          },
          tx,
        );
        return created;
      });
      return { id: asset.id, checksum, sizeBytes: buffer.length };
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async list(query: ListAssetsQueryDto): Promise<Paginated<AssetResponseDto>> {
    if (!!query.targetType !== !!query.targetId) {
      throw new BadRequestException(
        'targetType and targetId must be provided together',
      );
    }
    const where: Prisma.AssetWhereInput = {
      type: query.type,
      archivedAt: query.includeArchived ? undefined : null,
      ...(query.search && {
        originalName: { contains: query.search, mode: 'insensitive' },
      }),
      ...(query.targetType && {
        attachments: {
          some: { [TARGET_COLUMN[query.targetType]]: query.targetId },
        },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.asset.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.asset.count({ where }),
    ]);
    return paginated(
      rows.map(toAssetResponse),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<AssetResponseDto> {
    return toAssetResponse(await this.findOrThrow(id, true));
  }

  async downloadUrl(
    id: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): Promise<DownloadUrlResponseDto> {
    const asset = await this.findOrThrow(id);
    return this.storage.getDownloadUrl(asset.storageKey, {
      fileName: asset.originalName,
      contentType: asset.mimeType,
      disposition,
    });
  }

  async update(
    id: string,
    dto: UpdateAssetDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<AssetResponseDto> {
    const existing = await this.findOrThrow(id);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.asset.update({
        where: { id },
        data: { type: dto.type, description: dto.description },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ASSET_UPDATED,
          entityType: 'Asset',
          entityId: id,
          metadata: {
            ...(dto.type !== undefined && {
              type: { from: existing.type, to: updated.type },
            }),
            ...(dto.description !== undefined && { descriptionChanged: true }),
          },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toAssetResponse(row);
  }

  /** Archive keeps the bytes and the metadata; the asset just stops being listed/downloadable. */
  async archive(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const existing = await this.findOrThrow(id);
    const lockedByApprovedVersion = await this.prisma.assetAttachment.count({
      where: {
        assetId: id,
        patternVersion: { status: { in: ['APPROVED', 'SUPERSEDED'] } },
      },
    });
    if (lockedByApprovedVersion > 0) {
      throw new ConflictException(
        'Asset belongs to an approved pattern version and cannot be archived',
      );
    }
    const [onLockedSample, asArtwork, asProof] = await Promise.all([
      this.prisma.assetAttachment.count({
        where: { assetId: id, sample: { status: { not: 'DRAFT' } } },
      }),
      this.prisma.artworkVersion.count({
        where: { assetId: id, status: { not: 'REJECTED' } },
      }),
      this.prisma.payment.count({ where: { proofAssetId: id } }),
    ]);
    const asTechPack = await this.prisma.techPackVersion.count({
      where: { documentAssetId: id },
    });
    if (asTechPack > 0) {
      throw new ConflictException(
        'Asset is a tech pack document and cannot be archived',
      );
    }
    const asDeliveryProof = await this.prisma.shipment.count({
      where: { proofAssetId: id },
    });
    if (asDeliveryProof > 0) {
      throw new ConflictException(
        'Asset is a delivery proof and cannot be archived',
      );
    }
    const asEvidence = await this.prisma.assetAttachment.count({
      where: {
        assetId: id,
        OR: [
          { factoryJobId: { not: null } },
          { jobStageId: { not: null } },
          { qcInspectionId: { not: null } },
        ],
      },
    });
    if (asEvidence > 0) {
      throw new ConflictException(
        'Asset is production evidence and cannot be archived',
      );
    }
    if (onLockedSample > 0) {
      throw new ConflictException(
        'Asset is attached to a submitted sample and cannot be archived',
      );
    }
    if (asArtwork > 0) {
      throw new ConflictException(
        'Asset is used by an artwork version and cannot be archived',
      );
    }
    if (asProof > 0) {
      throw new ConflictException(
        'Asset is a payment proof and cannot be archived',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.asset.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ASSET_ARCHIVED,
          entityType: 'Asset',
          entityId: id,
          metadata: {
            originalName: existing.originalName,
            type: existing.type,
          },
          meta,
        },
        tx,
      );
    });
  }

  async listAttachments(id: string): Promise<AttachmentResponseDto[]> {
    await this.findOrThrow(id, true);
    const rows = await this.prisma.assetAttachment.findMany({
      where: { assetId: id },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAttachment);
  }

  async attach(
    id: string,
    dto: AttachAssetDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<AttachmentResponseDto> {
    const asset = await this.findOrThrow(id);
    if (dto.targetType === 'SAMPLE') {
      // Changing a sample's files is changing the sample: it needs the sample permission too.
      if (!actor.permissions.has('samples.manage')) {
        throw new ForbiddenException(
          'Attaching files to a sample requires samples.manage',
        );
      }
      if (
        !(SAMPLE_ATTACHABLE_TYPES as readonly string[]).includes(asset.type)
      ) {
        throw new BadRequestException(
          `A ${asset.type} file cannot be attached to a sample (allowed: ${SAMPLE_ATTACHABLE_TYPES.join(', ')})`,
        );
      }
    }
    if (FACTORY_TARGETS.includes(dto.targetType)) {
      if (!actor.permissions.has('production_notes.create')) {
        throw new ForbiddenException(
          'Attaching production evidence requires production_notes.create',
        );
      }
      if (
        !(FACTORY_ATTACHABLE_TYPES as readonly string[]).includes(asset.type)
      ) {
        throw new BadRequestException(
          `A ${asset.type} file cannot be attached to factory work (allowed: ${FACTORY_ATTACHABLE_TYPES.join(', ')})`,
        );
      }
    }
    await this.assertTargetAttachable(dto.targetType, dto.targetId);
    const column = TARGET_COLUMN[dto.targetType];
    if (
      await this.prisma.assetAttachment.findFirst({
        where: { assetId: id, [column]: dto.targetId },
      })
    ) {
      throw new ConflictException('Asset is already attached to this target');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.assetAttachment.create({
        data: {
          assetId: id,
          [column]: dto.targetId,
          createdByUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ASSET_ATTACHED,
          entityType: 'Asset',
          entityId: id,
          metadata: { targetType: dto.targetType, targetId: dto.targetId },
          meta,
        },
        tx,
      );
      return created;
    });
    return toAttachment(row);
  }

  async detach(
    id: string,
    attachmentId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const row = await this.prisma.assetAttachment.findFirst({
      where: { id: attachmentId, assetId: id },
      include: {
        patternVersion: { select: { status: true, patternId: true } },
        sample: { select: { status: true } },
      },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    if (row.sample && row.sample.status !== 'DRAFT') {
      throw new ConflictException('Files of a submitted sample are locked');
    }
    if (row.patternVersion && row.patternVersion.status !== 'DRAFT') {
      throw new ConflictException(
        'Files of an approved pattern version are immutable',
      );
    }
    if (row.factoryJobId || row.jobStageId || row.qcInspectionId) {
      throw new ConflictException(
        'Production evidence is part of the job record and cannot be detached',
      );
    }
    const attachment = toAttachment(row);
    await this.prisma.$transaction(async (tx) => {
      if (row.patternVersion) {
        // Serialise with pattern approval, which requires at least one pattern file.
        await tx.$queryRaw`SELECT id FROM patterns WHERE id = ${row.patternVersion.patternId}::uuid FOR UPDATE`;
        const current = await tx.patternVersion.findUniqueOrThrow({
          where: { id: row.patternVersionId! },
          select: { status: true },
        });
        if (current.status !== 'DRAFT') {
          throw new ConflictException(
            'Files of an approved pattern version are immutable',
          );
        }
      }
      await tx.assetAttachment.delete({ where: { id: attachmentId } });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ASSET_DETACHED,
          entityType: 'Asset',
          entityId: id,
          metadata: {
            targetType: attachment.targetType,
            targetId: attachment.targetId,
          },
          meta,
        },
        tx,
      );
    });
  }

  private async assertTargetAttachable(
    type: AssetTargetType,
    id: string,
  ): Promise<void> {
    const archived = (label: string) =>
      new ConflictException(`${label} is archived`);
    const missing = (label: string) =>
      new NotFoundException(`${label} not found`);
    switch (type) {
      case 'CUSTOMER': {
        const t = await this.prisma.customer.findUnique({
          where: { id },
          select: { archivedAt: true },
        });
        if (!t) throw missing('Customer');
        if (t.archivedAt) throw archived('Customer');
        return;
      }
      case 'BRAND': {
        const t = await this.prisma.brand.findUnique({
          where: { id },
          select: { archivedAt: true },
        });
        if (!t) throw missing('Brand');
        if (t.archivedAt) throw archived('Brand');
        return;
      }
      case 'FABRIC': {
        const t = await this.prisma.fabric.findUnique({
          where: { id },
          select: { archivedAt: true },
        });
        if (!t) throw missing('Fabric');
        if (t.archivedAt) throw archived('Fabric');
        return;
      }
      case 'PRODUCT_TYPE': {
        const t = await this.prisma.productType.findUnique({
          where: { id },
          select: { archivedAt: true },
        });
        if (!t) throw missing('Product type');
        if (t.archivedAt) throw archived('Product type');
        return;
      }
      case 'PRINT_METHOD': {
        const t = await this.prisma.printMethod.findUnique({
          where: { id },
          select: { archivedAt: true },
        });
        if (!t) throw missing('Print method');
        if (t.archivedAt) throw archived('Print method');
        return;
      }
      case 'SAMPLE': {
        const t = await this.prisma.sample.findUnique({
          where: { id },
          select: { status: true, archivedAt: true },
        });
        if (!t) throw missing('Sample');
        if (t.archivedAt) throw archived('Sample');
        if (t.status !== 'DRAFT') {
          throw new ConflictException(
            'Files can only be attached to a DRAFT sample',
          );
        }
        return;
      }
      case 'FACTORY_JOB': {
        const t = await this.prisma.factoryJob.findUnique({
          where: { id },
          select: { status: true },
        });
        if (!t) throw missing('Factory job');
        if (t.status === 'CANCELLED' || t.status === 'COMPLETED') {
          throw new ConflictException(`The job is ${t.status}`);
        }
        return;
      }
      case 'JOB_STAGE': {
        const t = await this.prisma.jobStage.findUnique({
          where: { id },
          select: { status: true, supersededAt: true },
        });
        if (!t) throw missing('Job stage');
        if (
          t.supersededAt ||
          !['READY', 'IN_PROGRESS', 'BLOCKED'].includes(t.status)
        ) {
          throw new ConflictException(
            'Evidence can only be attached to an active stage',
          );
        }
        return;
      }
      case 'QC_INSPECTION': {
        const t = await this.prisma.qcInspection.findUnique({
          where: { id },
          select: { status: true },
        });
        if (!t) throw missing('QC inspection');
        if (t.status !== 'IN_PROGRESS') {
          throw new ConflictException(
            'Photos can only be attached to an inspection in progress',
          );
        }
        return;
      }
      case 'PATTERN_VERSION': {
        const t = await this.prisma.patternVersion.findUnique({
          where: { id },
          select: { status: true, pattern: { select: { archivedAt: true } } },
        });
        if (!t) throw missing('Pattern version');
        if (t.pattern.archivedAt) throw archived('Pattern');
        if (t.status !== 'DRAFT') {
          throw new ConflictException(
            'Files can only be attached to a DRAFT pattern version',
          );
        }
        return;
      }
    }
  }

  private async findOrThrow(
    id: string,
    includeArchived = false,
  ): Promise<AssetRow> {
    const asset = await this.prisma.asset.findFirst({
      where: { id, archivedAt: includeArchived ? undefined : null },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    return asset;
  }
}
