import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  ArtworkResponseDto,
  ArtworkVersionResponseDto,
  CreateArtworkDto,
  CreateArtworkVersionDto,
  ListArtworksQueryDto,
  UpdateArtworkDto,
  UpdateArtworkVersionDto,
} from './dto/artwork.dto.js';

/** Asset types that can serve as an artwork file. */
export const ARTWORK_ASSET_TYPES = [
  'ARTWORK',
  'LOGO',
  'MOCKUP',
  'REFERENCE',
  'LABEL',
  'PACKAGING_REFERENCE',
  'OTHER',
];

const versionInclude = { asset: true } satisfies Prisma.ArtworkVersionInclude;
const artworkInclude = {
  versions: { orderBy: { versionNumber: 'desc' }, include: versionInclude },
} satisfies Prisma.ArtworkInclude;

type VersionRow = Prisma.ArtworkVersionGetPayload<{
  include: typeof versionInclude;
}>;
type ArtworkRow = Prisma.ArtworkGetPayload<{ include: typeof artworkInclude }>;

export const toArtworkVersion = (v: VersionRow): ArtworkVersionResponseDto => ({
  id: v.id,
  artworkId: v.artworkId,
  versionNumber: v.versionNumber,
  status: v.status,
  // Metadata only: never the storage key or a URL.
  asset: {
    assetId: v.asset.id,
    type: v.asset.type,
    originalName: v.asset.originalName,
    mimeType: v.asset.mimeType,
    sizeBytes: v.asset.sizeBytes,
  },
  notes: v.notes,
  rejectionReason: v.rejectionReason,
  createdAt: v.createdAt,
  approvedAt: v.approvedAt,
  rejectedAt: v.rejectedAt,
  supersededAt: v.supersededAt,
});

const toArtwork = (a: ArtworkRow): ArtworkResponseDto => ({
  id: a.id,
  brandId: a.brandId,
  sampleId: a.sampleId,
  name: a.name,
  purpose: a.purpose,
  approvedVersionId:
    a.versions.find((v) => v.status === 'APPROVED')?.id ?? null,
  versions: a.versions.map(toArtworkVersion),
  createdAt: a.createdAt,
  archivedAt: a.archivedAt,
});

/**
 * An Artwork is a named design; each uploaded file is an immutable ArtworkVersion.
 * Approval (recorded through the approvals module) promotes one version to APPROVED
 * and supersedes the previous one in the same transaction; the database also
 * guarantees there is never more than one approved version per artwork.
 */
@Injectable()
export class ArtworkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListArtworksQueryDto,
  ): Promise<Paginated<ArtworkResponseDto>> {
    const where: Prisma.ArtworkWhereInput = {
      brandId: query.brandId,
      sampleId: query.sampleId,
      purpose: query.purpose,
      archivedAt: query.includeArchived ? undefined : null,
      ...(query.search && {
        name: { contains: query.search, mode: 'insensitive' },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.artwork.findMany({
        where,
        include: artworkInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.artwork.count({ where }),
    ]);
    return paginated(rows.map(toArtwork), query.page, query.pageSize, total);
  }

  async get(id: string): Promise<ArtworkResponseDto> {
    return toArtwork(await this.find(id));
  }

  async create(
    dto: CreateArtworkDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ArtworkResponseDto> {
    if ((dto.brandId != null) === (dto.sampleId != null)) {
      throw new BadRequestException(
        'Provide exactly one of brandId or sampleId',
      );
    }
    if (dto.brandId) {
      const brand = await this.prisma.brand.findUnique({
        where: { id: dto.brandId },
      });
      if (!brand) throw new NotFoundException('Brand not found');
      if (brand.archivedAt) throw new ConflictException('Brand is archived');
    }
    if (dto.sampleId) await this.assertSampleOpen(dto.sampleId);
    await this.assertUsableAsset(dto.assetId);

    const created = await this.prisma.$transaction(async (tx) => {
      const artwork = await tx.artwork.create({
        data: {
          brandId: dto.brandId,
          sampleId: dto.sampleId,
          name: dto.name,
          purpose: dto.purpose,
          createdByUserId: actor.id,
          versions: {
            create: {
              versionNumber: 1,
              assetId: dto.assetId,
              notes: dto.notes,
              createdByUserId: actor.id,
            },
          },
        },
        include: { versions: true },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ARTWORK_CREATED,
          entityType: 'Artwork',
          entityId: artwork.id,
          metadata: {
            name: artwork.name,
            purpose: artwork.purpose,
            brandId: dto.brandId,
            sampleId: dto.sampleId,
          },
          meta,
        },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ARTWORK_VERSION_CREATED,
          entityType: 'ArtworkVersion',
          entityId: artwork.versions[0]!.id,
          metadata: {
            artworkId: artwork.id,
            versionNumber: 1,
            assetId: dto.assetId,
          },
          meta,
        },
        tx,
      );
      return artwork;
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateArtworkDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ArtworkResponseDto> {
    const existing = await this.find(id);
    if (existing.archivedAt) throw new ConflictException('Artwork is archived');
    const data = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(data).length) {
      await this.prisma.$transaction(async (tx) => {
        await tx.artwork.update({ where: { id }, data });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.ARTWORK_UPDATED,
            entityType: 'Artwork',
            entityId: id,
            metadata: { fields: Object.keys(data) },
            meta,
          },
          tx,
        );
      });
    }
    return this.get(id);
  }

  async archive(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const existing = await this.find(id);
    if (existing.archivedAt)
      throw new ConflictException('Artwork is already archived');
    const inUse = await this.prisma.sampleDecoration.count({
      where: { artworkId: id },
    });
    if (inUse > 0)
      throw new ConflictException(
        `Artwork is used by ${inUse} sample decoration(s)`,
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.artwork.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ARTWORK_ARCHIVED,
          entityType: 'Artwork',
          entityId: id,
          metadata: { name: existing.name },
          meta,
        },
        tx,
      );
    });
  }

  /** A new file is a new version; only one DRAFT can be open at a time. */
  async createVersion(
    artworkId: string,
    dto: CreateArtworkVersionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ArtworkVersionResponseDto> {
    const artwork = await this.find(artworkId);
    if (artwork.archivedAt) throw new ConflictException('Artwork is archived');
    if (artwork.sampleId) await this.assertSampleOpen(artwork.sampleId);
    await this.assertUsableAsset(dto.assetId);

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockArtwork(tx, artworkId);
      const open = await tx.artworkVersion.findFirst({
        where: { artworkId, status: 'DRAFT' },
      });
      if (open) {
        throw new ConflictException(
          `Version ${open.versionNumber} is still a DRAFT; get it approved or rejected before adding another`,
        );
      }
      if (
        await tx.artworkVersion.findFirst({
          where: { artworkId, assetId: dto.assetId },
        })
      ) {
        throw new ConflictException(
          'This file is already a version of this artwork',
        );
      }
      const latest = await tx.artworkVersion.aggregate({
        where: { artworkId },
        _max: { versionNumber: true },
      });
      const created = await tx.artworkVersion.create({
        data: {
          artworkId,
          versionNumber: (latest._max.versionNumber ?? 0) + 1,
          assetId: dto.assetId,
          notes: dto.notes,
          createdByUserId: actor.id,
        },
        include: versionInclude,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ARTWORK_VERSION_CREATED,
          entityType: 'ArtworkVersion',
          entityId: created.id,
          metadata: {
            artworkId,
            versionNumber: created.versionNumber,
            assetId: dto.assetId,
          },
          meta,
        },
        tx,
      );
      return created;
    });
    return toArtworkVersion(row);
  }

  async updateVersion(
    versionId: string,
    dto: UpdateArtworkVersionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ArtworkVersionResponseDto> {
    const existing = await this.prisma.artworkVersion.findUnique({
      where: { id: versionId },
    });
    if (!existing) throw new NotFoundException('Artwork version not found');
    if (existing.status !== 'DRAFT') {
      throw new ConflictException(
        `A ${existing.status} artwork version is immutable; upload a new version`,
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.artworkVersion.update({
        where: { id: versionId },
        data: { notes: dto.notes },
        include: versionInclude,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ARTWORK_VERSION_UPDATED,
          entityType: 'ArtworkVersion',
          entityId: versionId,
          metadata: {
            artworkId: existing.artworkId,
            versionNumber: existing.versionNumber,
            fields: ['notes'],
          },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toArtworkVersion(row);
  }

  // ---- decisions (called from the approvals module, inside its transaction) --------------

  /** Promote a DRAFT version to APPROVED, superseding the current approved one atomically. */
  async approveVersion(
    tx: Prisma.TransactionClient,
    versionId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const version = await tx.artworkVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException('Artwork version not found');
    await this.lockArtwork(tx, version.artworkId);
    const current = await tx.artworkVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    if (current.status !== 'DRAFT') {
      throw new ConflictException(
        `Artwork version ${current.versionNumber} is already ${current.status}`,
      );
    }
    const now = new Date();
    const previous = await tx.artworkVersion.findFirst({
      where: { artworkId: current.artworkId, status: 'APPROVED' },
    });
    if (previous) {
      await tx.artworkVersion.update({
        where: { id: previous.id },
        data: { status: 'SUPERSEDED', supersededAt: now },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ARTWORK_VERSION_SUPERSEDED,
          entityType: 'ArtworkVersion',
          entityId: previous.id,
          metadata: {
            artworkId: current.artworkId,
            versionNumber: previous.versionNumber,
            supersededBy: versionId,
          },
          meta,
        },
        tx,
      );
    }
    await tx.artworkVersion.update({
      where: { id: versionId },
      data: { status: 'APPROVED', approvedAt: now, approvedByUserId: actor.id },
    });
    await this.audit.record(
      {
        actorUserId: actor.id,
        action: AuditAction.ARTWORK_VERSION_APPROVED,
        entityType: 'ArtworkVersion',
        entityId: versionId,
        metadata: {
          artworkId: current.artworkId,
          versionNumber: current.versionNumber,
        },
        meta,
      },
      tx,
    );
  }

  async rejectVersion(
    tx: Prisma.TransactionClient,
    versionId: string,
    reason: string | null,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const version = await tx.artworkVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException('Artwork version not found');
    await this.lockArtwork(tx, version.artworkId);
    const current = await tx.artworkVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    if (current.status !== 'DRAFT') {
      throw new ConflictException(
        `Artwork version ${current.versionNumber} is already ${current.status}`,
      );
    }
    await tx.artworkVersion.update({
      where: { id: versionId },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
    });
    await this.audit.record(
      {
        actorUserId: actor.id,
        action: AuditAction.ARTWORK_VERSION_REJECTED,
        entityType: 'ArtworkVersion',
        entityId: versionId,
        metadata: {
          artworkId: current.artworkId,
          versionNumber: current.versionNumber,
          reason,
        },
        meta,
      },
      tx,
    );
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async lockArtwork(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM artworks WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private async find(id: string): Promise<ArtworkRow> {
    const artwork = await this.prisma.artwork.findUnique({
      where: { id },
      include: artworkInclude,
    });
    if (!artwork) throw new NotFoundException('Artwork not found');
    return artwork;
  }

  private async assertSampleOpen(sampleId: string): Promise<void> {
    const sample = await this.prisma.sample.findUnique({
      where: { id: sampleId },
      select: { status: true, archivedAt: true },
    });
    if (!sample) throw new NotFoundException('Sample not found');
    if (sample.archivedAt) throw new ConflictException('Sample is archived');
    if (
      ['COMPLETED', 'REJECTED', 'CANCELLED', 'APPROVED'].includes(sample.status)
    ) {
      throw new ConflictException(
        `Artwork cannot change while the sample is ${sample.status}`,
      );
    }
  }

  private async assertUsableAsset(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, archivedAt: null },
    });
    if (!asset) throw new BadRequestException('assetId: asset not found');
    if (!ARTWORK_ASSET_TYPES.includes(asset.type)) {
      throw new BadRequestException(
        `assetId: a ${asset.type} file cannot be used as artwork`,
      );
    }
  }
}
