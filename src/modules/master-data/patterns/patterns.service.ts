import { toPlain } from '../../../common/plain.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, crudAudit } from '../../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../../common/types/paginated.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { ReferenceService } from '../../../database/reference-sequence.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import type {
  CreatePatternDto,
  CreatePatternVersionDto,
  ListPatternsQueryDto,
  PatternDetailResponseDto,
  PatternResponseDto,
  PatternVersionResponseDto,
  UpdatePatternDto,
  UpdatePatternVersionDto,
} from './pattern.dto.js';

const patternInclude = {
  productType: { select: { id: true, code: true, name: true } },
  currentVersion: { select: { versionNumber: true } },
} satisfies Prisma.PatternInclude;

type PatternRow = Prisma.PatternGetPayload<{ include: typeof patternInclude }>;
type VersionRow = Prisma.PatternVersionGetPayload<object>;

const toPattern = (p: PatternRow): PatternResponseDto => ({
  id: p.id,
  referenceNumber: p.referenceNumber,
  code: p.code,
  name: p.name,
  productType: p.productType,
  description: p.description,
  fitType: p.fitType,
  status: p.status,
  notes: p.notes,
  currentVersionId: p.currentVersionId,
  currentVersionNumber: p.currentVersion?.versionNumber ?? null,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  archivedAt: p.archivedAt,
});

const toVersion = (v: VersionRow): PatternVersionResponseDto => ({
  id: v.id,
  patternId: v.patternId,
  versionNumber: v.versionNumber,
  status: v.status,
  notes: v.notes,
  approvedAt: v.approvedAt,
  approvedByUserId: v.approvedByUserId,
  createdByUserId: v.createdByUserId,
  createdAt: v.createdAt,
});

/**
 * A Pattern is the reusable identity of a fit; each PatternVersion is the
 * unit that gets approved. Approved versions are immutable: edits, new files
 * or detaching files require a new DRAFT version. Approving promotes the
 * version to `currentVersion` and supersedes the previous one.
 */
@Injectable()
export class PatternsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListPatternsQueryDto,
  ): Promise<Paginated<PatternResponseDto>> {
    const where: Prisma.PatternWhereInput = {
      productTypeId: query.productTypeId,
      status:
        query.status ??
        (query.includeArchived ? undefined : { not: 'ARCHIVED' }),
      ...(query.search && {
        OR: [
          { code: { contains: query.search, mode: 'insensitive' } },
          { referenceNumber: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.pattern.findMany({
        where,
        include: patternInclude,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.pattern.count({ where }),
    ]);
    return paginated(rows.map(toPattern), query.page, query.pageSize, total);
  }

  async get(id: string): Promise<PatternDetailResponseDto> {
    const pattern = await this.find(id, true);
    const versions = await this.prisma.patternVersion.findMany({
      where: { patternId: id },
      orderBy: { versionNumber: 'desc' },
    });
    return Object.assign(toPattern(pattern), {
      versions: versions.map(toVersion),
    });
  }

  async create(
    dto: CreatePatternDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PatternDetailResponseDto> {
    await this.assertProductType(dto.productTypeId);
    if (await this.prisma.pattern.findUnique({ where: { code: dto.code } })) {
      throw new ConflictException(`Pattern code ${dto.code} is already in use`);
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const referenceNumber = await this.references.next('PAT', tx);
      const pattern = await tx.pattern.create({
        data: {
          referenceNumber,
          code: dto.code,
          name: dto.name,
          productTypeId: dto.productTypeId,
          description: dto.description,
          fitType: dto.fitType,
          notes: dto.notes,
          createdByUserId: actor.id,
          versions: {
            create: {
              versionNumber: 1,
              notes: dto.versionNotes,
              createdByUserId: actor.id,
            },
          },
        },
        include: { versions: true },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: crudAudit('pattern').created,
          entityType: 'Pattern',
          entityId: pattern.id,
          metadata: { referenceNumber, code: pattern.code, name: pattern.name },
          meta,
        },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PATTERN_VERSION_CREATED,
          entityType: 'PatternVersion',
          entityId: pattern.versions[0]!.id,
          metadata: { patternId: pattern.id, versionNumber: 1 },
          meta,
        },
        tx,
      );
      return pattern;
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdatePatternDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PatternDetailResponseDto> {
    const existing = await this.find(id);
    if (dto.productTypeId && dto.productTypeId !== existing.productTypeId) {
      const approved = await this.prisma.patternVersion.count({
        where: { patternId: id, status: { in: ['APPROVED', 'SUPERSEDED'] } },
      });
      if (approved > 0) {
        throw new ConflictException(
          'The product type cannot change once a version has been approved',
        );
      }
      await this.assertProductType(dto.productTypeId);
    }
    const data = Object.fromEntries(
      Object.entries(
        Object.assign(toPlain(dto), { name: dto.name ?? undefined }),
      ).filter(([, v]) => v !== undefined),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.pattern.update({ where: { id }, data });
      if (Object.keys(data).length) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: crudAudit('pattern').updated,
            entityType: 'Pattern',
            entityId: id,
            metadata: { code: existing.code, fields: Object.keys(data) },
            meta,
          },
          tx,
        );
      }
    });
    return this.get(id);
  }

  async archive(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const existing = await this.find(id, true);
    if (existing.archivedAt)
      throw new ConflictException('Pattern is already archived');
    await this.prisma.$transaction(async (tx) => {
      await tx.pattern.update({
        where: { id },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: crudAudit('pattern').archived,
          entityType: 'Pattern',
          entityId: id,
          metadata: { code: existing.code, previousStatus: existing.status },
          meta,
        },
        tx,
      );
    });
  }

  async createVersion(
    patternId: string,
    dto: CreatePatternVersionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PatternVersionResponseDto> {
    await this.find(patternId);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockPattern(tx, patternId);
      const draft = await tx.patternVersion.findFirst({
        where: { patternId, status: 'DRAFT' },
      });
      if (draft) {
        throw new ConflictException(
          `Version ${draft.versionNumber} is still a DRAFT; approve or edit it before starting another`,
        );
      }
      const latest = await tx.patternVersion.aggregate({
        where: { patternId },
        _max: { versionNumber: true },
      });
      const version = await tx.patternVersion.create({
        data: {
          patternId,
          versionNumber: (latest._max.versionNumber ?? 0) + 1,
          notes: dto.notes,
          createdByUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PATTERN_VERSION_CREATED,
          entityType: 'PatternVersion',
          entityId: version.id,
          metadata: { patternId, versionNumber: version.versionNumber },
          meta,
        },
        tx,
      );
      return version;
    });
    return toVersion(row);
  }

  async updateVersion(
    patternId: string,
    versionId: string,
    dto: UpdatePatternVersionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PatternVersionResponseDto> {
    await this.find(patternId);
    const existing = await this.findVersion(patternId, versionId);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException(
        'Approved pattern versions are immutable; create a new version',
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.patternVersion.update({
        where: { id: versionId },
        data: { notes: dto.notes },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PATTERN_VERSION_UPDATED,
          entityType: 'PatternVersion',
          entityId: versionId,
          metadata: {
            patternId,
            versionNumber: existing.versionNumber,
            fields: ['notes'],
          },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toVersion(row);
  }

  async approveVersion(
    patternId: string,
    versionId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PatternDetailResponseDto> {
    await this.find(patternId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockPattern(tx, patternId);
      const version = await tx.patternVersion.findFirst({
        where: { id: versionId, patternId },
      });
      if (!version) throw new NotFoundException('Pattern version not found');
      if (version.status !== 'DRAFT') {
        throw new ConflictException(
          `Version ${version.versionNumber} is already ${version.status}`,
        );
      }
      // An approved version is a production reference: it must carry its pattern file(s).
      const patternFiles = await tx.assetAttachment.count({
        where: {
          patternVersionId: versionId,
          asset: { type: 'PATTERN', archivedAt: null },
        },
      });
      if (patternFiles === 0) {
        throw new ConflictException(
          `Version ${version.versionNumber} has no attached PATTERN file; attach one before approving`,
        );
      }
      const pattern = await tx.pattern.findUniqueOrThrow({
        where: { id: patternId },
      });
      if (pattern.currentVersionId) {
        await tx.patternVersion.update({
          where: { id: pattern.currentVersionId },
          data: { status: 'SUPERSEDED' },
        });
      }
      await tx.patternVersion.update({
        where: { id: versionId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedByUserId: actor.id,
        },
      });
      await tx.pattern.update({
        where: { id: patternId },
        data: { currentVersionId: versionId, status: 'ACTIVE' },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PATTERN_VERSION_APPROVED,
          entityType: 'PatternVersion',
          entityId: versionId,
          metadata: {
            patternId,
            code: pattern.code,
            versionNumber: version.versionNumber,
            supersededVersionId: pattern.currentVersionId,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(patternId);
  }

  // ---- helpers -------------------------------------------------------------

  /** Serialise version creation/approval per pattern (SELECT .. FOR UPDATE). */
  private async lockPattern(
    tx: Prisma.TransactionClient,
    patternId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM patterns WHERE id = ${patternId}::uuid FOR UPDATE`;
  }

  private async find(id: string, includeArchived = false): Promise<PatternRow> {
    const pattern = await this.prisma.pattern.findFirst({
      where: { id, ...(includeArchived ? {} : { archivedAt: null }) },
      include: patternInclude,
    });
    if (!pattern) throw new NotFoundException('Pattern not found');
    return pattern;
  }

  private async findVersion(
    patternId: string,
    versionId: string,
  ): Promise<VersionRow> {
    const version = await this.prisma.patternVersion.findFirst({
      where: { id: versionId, patternId },
    });
    if (!version) throw new NotFoundException('Pattern version not found');
    return version;
  }

  private async assertProductType(id: string): Promise<void> {
    const pt = await this.prisma.productType.findFirst({
      where: { id, archivedAt: null },
      select: { id: true },
    });
    if (!pt)
      throw new BadRequestException('Product type not found or archived');
  }
}
