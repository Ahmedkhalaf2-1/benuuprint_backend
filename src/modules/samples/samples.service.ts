import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import { normalizePhone } from '../../common/transforms.js';
import {
  auditActor,
  type ActorRef,
  type AuthUser,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ReferenceService } from '../../database/reference-sequence.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateSampleDto,
  ListSamplesQueryDto,
  SampleDetailResponseDto,
  SampleListItemDto,
  SampleStatusHistoryDto,
  UpdateSampleDto,
} from './dto/sample.dto.js';
import {
  sampleDetailInclude,
  sampleListInclude,
  toSampleDetail,
  toSampleListItem,
} from './sample.mapper.js';
import {
  areNotesEditable,
  isRevisable,
  isSpecEditable,
} from './sample-state-machine.js';

/** Fields that describe the product; locked once the sample leaves DRAFT. */
export const SPEC_FIELDS = [
  'productTypeId',
  'customProductName',
  'customProductDescription',
  'fabricId',
  'customFabricName',
  'customFabricDescription',
  'fabricColorId',
  'customColorName',
  'customPantone',
  'customHex',
  'fabricProvider',
  'gsm',
  'sampleSizeOptionId',
  'fitMethod',
  'patternVersionId',
] as const;

/** Free-text fields that staff may still refine while a sample is under review. */
export const NOTE_FIELDS = [
  'notes',
  'fitNotes',
  'printNotes',
  'fabricNotes',
  'specialInstructions',
  'factoryInstructions',
] as const;

/** Relation-ish changes worth recording old → new in the audit trail. */
const TRACKED_FIELDS = [
  'brandId',
  'productTypeId',
  'fabricId',
  'fabricColorId',
  'patternVersionId',
  'sampleSizeOptionId',
  'fitMethod',
  'fabricProvider',
] as const;

type SpecState = {
  productTypeId: string | null;
  customProductName: string | null;
  fabricId: string | null;
  customFabricName: string | null;
  fabricColorId: string | null;
  customColorName: string | null;
  customPantone: string | null;
  customHex: string | null;
  sampleSizeOptionId: string | null;
  fitMethod: string;
  patternVersionId: string | null;
  brandId: string;
};

@Injectable()
export class SamplesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
  ) {}

  // ---- reads ----------------------------------------------------------------

  async list(
    query: ListSamplesQueryDto,
  ): Promise<Paginated<SampleListItemDto>> {
    const search = query.search?.trim();
    const phone = search ? normalizePhone(search) : undefined;
    const range = (from?: Date, to?: Date) =>
      from || to ? { gte: from, lte: to } : undefined;
    const where: Prisma.SampleWhereInput = {
      archivedAt: query.includeArchived ? undefined : null,
      status: query.status?.length ? { in: query.status } : undefined,
      customerId: query.customerId,
      brandId: query.brandId,
      productTypeId: query.productTypeId,
      fabricId: query.fabricId,
      paymentState: query.paymentState,
      assignedSalesUserId: query.unassigned ? null : query.assignedSalesUserId,
      createdAt: range(query.createdFrom, query.createdTo),
      submittedAt: range(query.submittedFrom, query.submittedTo),
      approvals: query.approvalState
        ? { some: { status: query.approvalState } }
        : undefined,
      ...(search && {
        OR: [
          { sampleNumber: { contains: search, mode: 'insensitive' } },
          {
            brand: { is: { name: { contains: search, mode: 'insensitive' } } },
          },
          {
            customer: {
              is: {
                OR: [
                  { customerNumber: { contains: search, mode: 'insensitive' } },
                  { displayName: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                  { phone: { contains: phone ?? search } },
                  { whatsapp: { contains: phone ?? search } },
                ],
              },
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
    const orderBy: Prisma.SampleOrderByWithRelationInput[] = [
      sorts[query.sort]!,
      { id: 'asc' },
    ];

    // One query with joins (customer, brand, product, fabric, sales owner) plus a count: no N+1.
    const [rows, total] = await Promise.all([
      this.prisma.sample.findMany({
        where,
        include: sampleListInclude,
        orderBy,
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.sample.count({ where }),
    ]);
    return paginated(
      rows.map(toSampleListItem),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<SampleDetailResponseDto> {
    const sample = await this.prisma.sample.findUnique({
      where: { id },
      include: sampleDetailInclude,
    });
    if (!sample) throw new NotFoundException('Sample not found');
    return toSampleDetail(sample);
  }

  async history(id: string): Promise<SampleStatusHistoryDto[]> {
    await this.assertExists(id);
    const rows = await this.prisma.sampleStatusHistory.findMany({
      where: { sampleId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ ...r, source: r.source }));
  }

  // ---- create / update ---------------------------------------------------------

  async create(
    dto: CreateSampleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    return this.createFor(dto, actor, meta);
  }

  /** Shared by staff (AuthUser) and the customer portal (customer actor); the Sample domain rules are the same. */
  async createFor(
    dto: CreateSampleDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer)
      throw new BadRequestException('customerId: customer not found');
    if (customer.status === 'ARCHIVED' || customer.status === 'BLOCKED') {
      throw new ConflictException(
        `Customer is ${customer.status.toLowerCase()} and cannot get new samples`,
      );
    }
    const state = this.toState(dto, dto.brandId);
    await this.assertDraftSpecValid(state, dto.customerId);

    const { customerId: _c, brandId: _b, ...fields } = dto;
    const created = await this.prisma.$transaction(async (tx) => {
      const sampleNumber = await this.references.next('SMP', tx);
      const sample = await tx.sample.create({
        data: {
          ...Object.fromEntries(
            Object.entries(fields).filter(
              ([, v]) => v !== undefined && v !== null,
            ),
          ),
          sampleNumber,
          customerId: dto.customerId,
          brandId: dto.brandId,
          createdByStaffUserId: actor.customer ? null : actor.id,
          createdByCustomerId: actor.customer ? actor.id : null,
        },
      });
      await tx.sampleStatusHistory.create({
        data: {
          sampleId: sample.id,
          toStatus: 'DRAFT',
          action: 'create',
          ...auditActor(actor),
          source: actor.customer ? 'CUSTOMER' : 'STAFF',
        },
      });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.SAMPLE_CREATED,
          entityType: 'Sample',
          entityId: sample.id,
          metadata: {
            sampleNumber,
            customerId: dto.customerId,
            brandId: dto.brandId,
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
      return sample;
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateSampleDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    const existing = await this.prisma.sample.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sample not found');
    if (existing.archivedAt) throw new ConflictException('Sample is archived');

    const given = (key: string) =>
      (dto as Record<string, unknown>)[key] !== undefined;
    const specKeys = [...SPEC_FIELDS, 'brandId'].filter(given);
    const noteKeys = NOTE_FIELDS.filter(given);
    if (specKeys.length && !isSpecEditable(existing.status)) {
      throw new ConflictException(
        `The specification is locked while the sample is ${existing.status}. ` +
          'Request changes to reopen it, or create a revision of an approved sample.',
      );
    }
    if (noteKeys.length && !areNotesEditable(existing.status)) {
      throw new ConflictException(
        `Notes can no longer be edited while the sample is ${existing.status}`,
      );
    }

    const merged = this.mergeState(existing, dto);
    await this.assertDraftSpecValid(merged, existing.customerId);

    const data: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const fields: string[] = [];
    for (const key of [...specKeys, ...noteKeys]) {
      const next = (dto as Record<string, unknown>)[key];
      const prev = (existing as Record<string, unknown>)[key];
      if (next === prev) continue;
      data[key] = next;
      fields.push(key);
      if ((TRACKED_FIELDS as readonly string[]).includes(key))
        changes[key] = { from: prev, to: next };
    }
    if (fields.length === 0) return this.get(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.sample.update({ where: { id }, data });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.SAMPLE_UPDATED,
          entityType: 'Sample',
          entityId: id,
          metadata: {
            sampleNumber: existing.sampleNumber,
            status: existing.status,
            fields,
            changes,
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Soft-archive a sample that never entered (or has left) the commercial flow. */
  async archive(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const existing = await this.prisma.sample.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sample not found');
    if (existing.archivedAt)
      throw new ConflictException('Sample is already archived');
    if (!['DRAFT', 'CANCELLED', 'REJECTED'].includes(existing.status)) {
      throw new ConflictException(
        `A ${existing.status} sample is part of the commercial record; cancel or reject it first`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.sample.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SAMPLE_ARCHIVED,
          entityType: 'Sample',
          entityId: id,
          metadata: {
            sampleNumber: existing.sampleNumber,
            status: existing.status,
          },
          meta,
        },
        tx,
      );
    });
  }

  // ---- revisions -------------------------------------------------------------

  /**
   * Approved (or otherwise locked) samples are never edited. A revision is a new
   * DRAFT sample that copies the specification and links back to its origin; it
   * goes through submission, quotation and approval again. Quotations, payments,
   * approvals, notes and terms acceptances are deliberately NOT copied.
   */
  async revise(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SampleDetailResponseDto> {
    const source = await this.prisma.sample.findUnique({
      where: { id },
      include: {
        decorations: { orderBy: { sortOrder: 'asc' } },
        accessories: true,
        components: true,
        attachments: {
          include: { asset: { select: { type: true, archivedAt: true } } },
        },
      },
    });
    if (!source) throw new NotFoundException('Sample not found');
    if (source.archivedAt) throw new ConflictException('Sample is archived');
    if (!isRevisable(source.status)) {
      throw new ConflictException(
        'A DRAFT is edited directly; revisions are for samples that have been submitted',
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${id}::uuid FOR UPDATE`;
      const open = await tx.sample.count({
        where: {
          revisionOfId: id,
          archivedAt: null,
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
      });
      if (open > 0)
        throw new ConflictException('This sample already has an open revision');

      const sampleNumber = await this.references.next('SMP', tx);
      const copy = await tx.sample.create({
        data: {
          sampleNumber,
          customerId: source.customerId,
          brandId: source.brandId,
          revisionOfId: source.id,
          revisionNumber: source.revisionNumber + 1,
          productTypeId: source.productTypeId,
          customProductName: source.customProductName,
          customProductDescription: source.customProductDescription,
          fabricId: source.fabricId,
          customFabricName: source.customFabricName,
          customFabricDescription: source.customFabricDescription,
          fabricColorId: source.fabricColorId,
          customColorName: source.customColorName,
          customPantone: source.customPantone,
          customHex: source.customHex,
          fabricProvider: source.fabricProvider,
          gsm: source.gsm,
          sampleSizeOptionId: source.sampleSizeOptionId,
          fitMethod: source.fitMethod,
          patternVersionId: source.patternVersionId,
          notes: source.notes,
          fitNotes: source.fitNotes,
          printNotes: source.printNotes,
          fabricNotes: source.fabricNotes,
          specialInstructions: source.specialInstructions,
          factoryInstructions: source.factoryInstructions,
          assignedSalesUserId: source.assignedSalesUserId,
          createdByStaffUserId: actor.id,
        },
      });

      // Sample-owned artwork is re-created for the copy (latest usable file as a new DRAFT version);
      // brand-owned artwork is simply referenced.
      const artworkMap = new Map<string, string>();
      for (const d of source.decorations) {
        if (!d.artworkId || artworkMap.has(d.artworkId)) continue;
        const artwork = await tx.artwork.findUniqueOrThrow({
          where: { id: d.artworkId },
          include: {
            versions: {
              where: { status: { not: 'REJECTED' } },
              orderBy: { versionNumber: 'desc' },
              take: 1,
            },
          },
        });
        if (artwork.sampleId !== source.id) {
          artworkMap.set(d.artworkId, d.artworkId);
          continue;
        }
        const latest = artwork.versions[0];
        if (!latest) continue;
        const clone = await tx.artwork.create({
          data: {
            sampleId: copy.id,
            name: artwork.name,
            purpose: artwork.purpose,
            createdByUserId: actor.id,
            versions: {
              create: {
                versionNumber: 1,
                assetId: latest.assetId,
                notes: `Copied from ${source.sampleNumber} (version ${latest.versionNumber})`,
                createdByUserId: actor.id,
              },
            },
          },
        });
        artworkMap.set(d.artworkId, clone.id);
      }
      for (const d of source.decorations) {
        await tx.sampleDecoration.create({
          data: {
            sampleId: copy.id,
            printMethodId: d.printMethodId,
            placement: d.placement,
            side: d.side,
            width: d.width,
            height: d.height,
            unit: d.unit,
            colorCount: d.colorCount,
            notes: d.notes,
            artworkRequired: d.artworkRequired,
            artworkId: d.artworkId
              ? (artworkMap.get(d.artworkId) ?? null)
              : null,
            sortOrder: d.sortOrder,
          },
        });
      }
      for (const a of source.accessories) {
        await tx.sampleAccessory.create({
          data: {
            sampleId: copy.id,
            accessoryId: a.accessoryId,
            customName: a.customName,
            quantity: a.quantity,
            notes: a.notes,
            sortOrder: a.sortOrder,
          },
        });
      }
      for (const c of source.components) {
        await tx.sampleComponent.create({
          data: {
            sampleId: copy.id,
            componentOptionId: c.componentOptionId,
            customName: c.customName,
            notes: c.notes,
            sortOrder: c.sortOrder,
          },
        });
      }
      for (const att of source.attachments) {
        if (att.asset.archivedAt) continue;
        await tx.assetAttachment.create({
          data: {
            assetId: att.assetId,
            sampleId: copy.id,
            createdByUserId: actor.id,
          },
        });
      }
      await tx.sampleStatusHistory.create({
        data: {
          sampleId: copy.id,
          toStatus: 'DRAFT',
          action: 'create-revision',
          reason: `Revision of ${source.sampleNumber}`,
          actorUserId: actor.id,
          source: 'STAFF',
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SAMPLE_REVISION_CREATED,
          entityType: 'Sample',
          entityId: copy.id,
          metadata: {
            sampleNumber,
            revisionOfId: source.id,
            revisionOfNumber: source.sampleNumber,
            revisionNumber: copy.revisionNumber,
          },
          meta,
        },
        tx,
      );
      return copy;
    });
    return this.get(created.id);
  }

  // ---- helpers -----------------------------------------------------------------

  async assertExists(id: string): Promise<void> {
    if (
      !(await this.prisma.sample.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Sample not found');
    }
  }

  private toState(dto: Partial<CreateSampleDto>, brandId: string): SpecState {
    return {
      brandId,
      productTypeId: dto.productTypeId ?? null,
      customProductName: dto.customProductName ?? null,
      fabricId: dto.fabricId ?? null,
      customFabricName: dto.customFabricName ?? null,
      fabricColorId: dto.fabricColorId ?? null,
      customColorName: dto.customColorName ?? null,
      customPantone: dto.customPantone ?? null,
      customHex: dto.customHex ?? null,
      sampleSizeOptionId: dto.sampleSizeOptionId ?? null,
      fitMethod: dto.fitMethod ?? 'NOT_SURE',
      patternVersionId: dto.patternVersionId ?? null,
    };
  }

  /** Existing row overlaid with the PATCH (omitted = unchanged, null = cleared). */
  private mergeState(existing: SpecState, dto: UpdateSampleDto): SpecState {
    const out: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined && key in out) out[key] = value;
    }
    return out as SpecState;
  }

  /**
   * Consistency rules that hold for every save, drafts included: mutually
   * exclusive pairs, references that must exist and be usable, colour/fabric
   * and pattern/fit coherence. Completeness is a submit-time concern.
   * Nothing is silently corrected; the caller must clear the conflicting side.
   */
  private async assertDraftSpecValid(
    s: SpecState,
    customerId: string,
  ): Promise<void> {
    const problems: string[] = [];
    const clearHint = (a: string, b: string) =>
      `${a} and ${b} are mutually exclusive; send ${b}: null to switch to ${a}`;

    if (s.productTypeId && s.customProductName)
      problems.push(clearHint('productTypeId', 'customProductName'));
    if (s.fabricId && s.customFabricName)
      problems.push(clearHint('fabricId', 'customFabricName'));
    if (
      s.fabricColorId &&
      (s.customColorName || s.customPantone || s.customHex)
    ) {
      problems.push(
        'fabricColorId and custom color fields (customColorName, customPantone, customHex) are mutually exclusive',
      );
    }
    if (s.fabricColorId && !s.fabricId)
      problems.push('fabricColorId requires fabricId');
    if (s.patternVersionId && s.fitMethod !== 'BENUE_PATTERN') {
      problems.push(
        'patternVersionId can only be set when fitMethod is BENUE_PATTERN',
      );
    }

    const brand = await this.prisma.brand.findUnique({
      where: { id: s.brandId },
    });
    if (!brand) problems.push('brandId: brand not found');
    else if (brand.customerId !== customerId)
      problems.push('brandId: brand belongs to a different customer');
    else if (brand.archivedAt) problems.push('brandId: brand is archived');

    if (s.productTypeId) {
      const pt = await this.prisma.productType.findUnique({
        where: { id: s.productTypeId },
      });
      if (!pt || pt.archivedAt || !pt.isActive)
        problems.push('productTypeId: product type not found or inactive');
    }
    if (s.fabricId) {
      const fabric = await this.prisma.fabric.findUnique({
        where: { id: s.fabricId },
      });
      if (!fabric || fabric.archivedAt || !fabric.isActive)
        problems.push('fabricId: fabric not found or inactive');
    }
    if (s.fabricColorId && s.fabricId) {
      const color = await this.prisma.fabricColor.findUnique({
        where: { id: s.fabricColorId },
      });
      if (!color || color.archivedAt || !color.isActive || !color.isAvailable) {
        problems.push('fabricColorId: color not found or unavailable');
      } else if (color.fabricId !== s.fabricId) {
        problems.push(
          'fabricColorId: color does not belong to the selected fabric',
        );
      }
    }
    if (s.sampleSizeOptionId) {
      const size = await this.prisma.sizeOption.findUnique({
        where: { id: s.sampleSizeOptionId },
      });
      if (!size || size.archivedAt || !size.isActive)
        problems.push('sampleSizeOptionId: size not found or inactive');
    }
    if (s.patternVersionId) {
      const version = await this.prisma.patternVersion.findUnique({
        where: { id: s.patternVersionId },
        include: { pattern: true },
      });
      if (!version)
        problems.push('patternVersionId: pattern version not found');
      else if (version.pattern.archivedAt)
        problems.push('patternVersionId: pattern is archived');
      else if (version.status !== 'APPROVED') {
        problems.push(
          `patternVersionId: only APPROVED pattern versions can be used (this one is ${version.status})`,
        );
      }
    }
    if (problems.length) throw new BadRequestException(problems);
  }
}
