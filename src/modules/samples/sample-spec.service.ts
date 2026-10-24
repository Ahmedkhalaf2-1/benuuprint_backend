import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import {
  auditActor,
  type ActorRef,
  type AuthUser,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AssetsService,
  SAMPLE_ATTACHABLE_TYPES,
} from '../assets/assets.service.js';
import type { AttachmentResponseDto } from '../assets/dto/asset.dto.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateDecorationDto,
  CreateSampleAccessoryDto,
  CreateSampleComponentDto,
  UpdateDecorationDto,
  UpdateSampleAccessoryDto,
  UpdateSampleComponentDto,
} from './dto/sample-spec.dto.js';
import type {
  SampleAccessoryDto,
  SampleAttachmentDto,
  SampleComponentDto,
  SampleDecorationDto,
} from './dto/sample.dto.js';
import { isSpecEditable } from './sample-state-machine.js';

const decorationInclude = {
  printMethod: { select: { id: true, code: true, name: true } },
} as const;
const accessoryInclude = {
  accessory: { select: { id: true, code: true, name: true } },
} as const;
const componentInclude = {
  componentOption: {
    select: { id: true, code: true, name: true, category: true },
  },
} as const;

type DecorationRow = Prisma.SampleDecorationGetPayload<{
  include: typeof decorationInclude;
}>;
type AccessoryRow = Prisma.SampleAccessoryGetPayload<{
  include: typeof accessoryInclude;
}>;
type ComponentRow = Prisma.SampleComponentGetPayload<{
  include: typeof componentInclude;
}>;

const toDecoration = (d: DecorationRow): SampleDecorationDto => ({
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
  artworkId: d.artworkId,
  sortOrder: d.sortOrder,
});
const toAccessory = (a: AccessoryRow): SampleAccessoryDto => ({
  id: a.id,
  accessory: a.accessory,
  customName: a.customName,
  quantity: a.quantity,
  notes: a.notes,
  sortOrder: a.sortOrder,
});
const toComponent = (c: ComponentRow): SampleComponentDto => ({
  id: c.id,
  componentOption: c.componentOption
    ? {
        id: c.componentOption.id,
        code: c.componentOption.code,
        name: c.componentOption.name,
      }
    : null,
  category: c.componentOption?.category ?? null,
  customName: c.customName,
  notes: c.notes,
  sortOrder: c.sortOrder,
});

/** Edits to the parts of a sample's specification (only while it is a DRAFT). */
@Injectable()
export class SampleSpecService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly assets: AssetsService,
  ) {}

  // ---- decorations ---------------------------------------------------------------

  async createDecoration(
    sampleId: string,
    dto: CreateDecorationDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleDecorationDto> {
    const sample = await this.editableSample(sampleId);
    this.assertSizeUnit(dto.width, dto.height, dto.unit);
    await this.assertPrintMethod(dto.printMethodId);
    if (dto.artworkId) await this.assertArtworkUsable(dto.artworkId, sample);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, sampleId);
      const created = await tx.sampleDecoration.create({
        data: {
          sampleId,
          printMethodId: dto.printMethodId,
          placement: dto.placement,
          side: dto.side,
          width: dto.width,
          height: dto.height,
          unit: dto.unit,
          colorCount: dto.colorCount,
          notes: dto.notes,
          artworkRequired: dto.artworkRequired ?? false,
          artworkId: dto.artworkId,
          sortOrder: dto.sortOrder ?? 0,
        },
        include: decorationInclude,
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_DECORATION_CREATED,
        'SampleDecoration',
        created.id,
        {
          sampleId,
          printMethodId: created.printMethodId,
          placement: created.placement,
        },
      );
      return created;
    });
    return toDecoration(row);
  }

  async updateDecoration(
    id: string,
    dto: UpdateDecorationDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleDecorationDto> {
    const existing = await this.prisma.sampleDecoration.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Decoration not found');
    const sample = await this.editableSample(existing.sampleId);
    const width =
      dto.width === undefined ? existing.width?.toNumber() : dto.width;
    const height =
      dto.height === undefined ? existing.height?.toNumber() : dto.height;
    const unit = dto.unit === undefined ? existing.unit : dto.unit;
    this.assertSizeUnit(
      width ?? undefined,
      height ?? undefined,
      unit ?? undefined,
    );
    if (dto.printMethodId) await this.assertPrintMethod(dto.printMethodId);
    if (dto.artworkId) await this.assertArtworkUsable(dto.artworkId, sample);

    const data = Object.fromEntries(
      Object.entries(dto).filter(
        ([k, v]) =>
          v !== undefined &&
          !(
            v === null &&
            [
              'printMethodId',
              'placement',
              'side',
              'artworkRequired',
              'sortOrder',
            ].includes(k)
          ),
      ),
    ) as Prisma.SampleDecorationUncheckedUpdateInput;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${existing.sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, existing.sampleId);
      const updated = await tx.sampleDecoration.update({
        where: { id },
        data,
        include: decorationInclude,
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_DECORATION_UPDATED,
        'SampleDecoration',
        id,
        {
          sampleId: existing.sampleId,
          fields: Object.keys(data),
        },
      );
      return updated;
    });
    return toDecoration(row);
  }

  async removeDecoration(
    id: string,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.prisma.sampleDecoration.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Decoration not found');
    await this.editableSample(existing.sampleId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${existing.sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, existing.sampleId);
      await tx.sampleDecoration.delete({ where: { id } });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_DECORATION_REMOVED,
        'SampleDecoration',
        id,
        {
          sampleId: existing.sampleId,
          printMethodId: existing.printMethodId,
          placement: existing.placement,
        },
      );
    });
  }

  // ---- accessories -----------------------------------------------------------------

  async createAccessory(
    sampleId: string,
    dto: CreateSampleAccessoryDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleAccessoryDto> {
    await this.editableSample(sampleId);
    this.assertExactlyOne(
      dto.accessoryId,
      dto.customName,
      'accessoryId',
      'customName',
    );
    if (dto.accessoryId) {
      const accessory = await this.prisma.accessory.findUnique({
        where: { id: dto.accessoryId },
      });
      if (!accessory || accessory.archivedAt || !accessory.isActive) {
        throw new BadRequestException(
          'accessoryId: accessory not found or inactive',
        );
      }
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, sampleId);
      const created = await tx.sampleAccessory.create({
        data: {
          sampleId,
          ...this.pick(dto, ['accessoryId', 'customName', 'quantity', 'notes']),
          sortOrder: dto.sortOrder ?? 0,
        },
        include: accessoryInclude,
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_ACCESSORY_CREATED,
        'SampleAccessory',
        created.id,
        {
          sampleId,
          accessoryId: created.accessoryId,
          customName: created.customName,
        },
      );
      return created;
    });
    return toAccessory(row);
  }

  async updateAccessory(
    id: string,
    dto: UpdateSampleAccessoryDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleAccessoryDto> {
    const existing = await this.prisma.sampleAccessory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Sample accessory not found');
    await this.editableSample(existing.sampleId);
    if (dto.customName !== undefined && !existing.customName) {
      throw new BadRequestException(
        'customName can only be changed on a custom accessory',
      );
    }
    const data = this.pick(dto, [
      'quantity',
      'notes',
      'sortOrder',
      'customName',
    ]);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${existing.sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, existing.sampleId);
      const updated = await tx.sampleAccessory.update({
        where: { id },
        data,
        include: accessoryInclude,
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_ACCESSORY_UPDATED,
        'SampleAccessory',
        id,
        {
          sampleId: existing.sampleId,
          fields: Object.keys(data),
        },
      );
      return updated;
    });
    return toAccessory(row);
  }

  async removeAccessory(
    id: string,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.prisma.sampleAccessory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Sample accessory not found');
    await this.editableSample(existing.sampleId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${existing.sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, existing.sampleId);
      await tx.sampleAccessory.delete({ where: { id } });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_ACCESSORY_REMOVED,
        'SampleAccessory',
        id,
        {
          sampleId: existing.sampleId,
          accessoryId: existing.accessoryId,
          customName: existing.customName,
        },
      );
    });
  }

  // ---- labels & packaging -------------------------------------------------------------

  async createComponent(
    sampleId: string,
    dto: CreateSampleComponentDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleComponentDto> {
    await this.editableSample(sampleId);
    this.assertExactlyOne(
      dto.componentOptionId,
      dto.customName,
      'componentOptionId',
      'customName',
    );
    if (dto.componentOptionId) {
      const option = await this.prisma.componentOption.findUnique({
        where: { id: dto.componentOptionId },
      });
      if (!option || option.archivedAt || !option.isActive) {
        throw new BadRequestException(
          'componentOptionId: option not found or inactive',
        );
      }
      const dup = await this.prisma.sampleComponent.findFirst({
        where: { sampleId, componentOptionId: dto.componentOptionId },
      });
      if (dup)
        throw new ConflictException(
          'This label/packaging option is already selected',
        );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, sampleId);
      const created = await tx.sampleComponent.create({
        data: {
          sampleId,
          ...this.pick(dto, ['componentOptionId', 'customName', 'notes']),
          sortOrder: dto.sortOrder ?? 0,
        },
        include: componentInclude,
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_COMPONENT_CREATED,
        'SampleComponent',
        created.id,
        {
          sampleId,
          componentOptionId: created.componentOptionId,
          customName: created.customName,
        },
      );
      return created;
    });
    return toComponent(row);
  }

  async updateComponent(
    id: string,
    dto: UpdateSampleComponentDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleComponentDto> {
    const existing = await this.prisma.sampleComponent.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Sample component not found');
    await this.editableSample(existing.sampleId);
    if (dto.customName !== undefined && !existing.customName) {
      throw new BadRequestException(
        'customName can only be changed on a custom component',
      );
    }
    const data = this.pick(dto, ['notes', 'sortOrder', 'customName']);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${existing.sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, existing.sampleId);
      const updated = await tx.sampleComponent.update({
        where: { id },
        data,
        include: componentInclude,
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_COMPONENT_UPDATED,
        'SampleComponent',
        id,
        {
          sampleId: existing.sampleId,
          fields: Object.keys(data),
        },
      );
      return updated;
    });
    return toComponent(row);
  }

  async removeComponent(
    id: string,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.prisma.sampleComponent.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Sample component not found');
    await this.editableSample(existing.sampleId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${existing.sampleId}::uuid FOR UPDATE`;
      await this.assertStillDraft(tx, existing.sampleId);
      await tx.sampleComponent.delete({ where: { id } });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.SAMPLE_COMPONENT_REMOVED,
        'SampleComponent',
        id,
        {
          sampleId: existing.sampleId,
          componentOptionId: existing.componentOptionId,
          customName: existing.customName,
        },
      );
    });
  }

  // ---- files ---------------------------------------------------------------------------

  async listAssets(sampleId: string): Promise<SampleAttachmentDto[]> {
    if (
      !(await this.prisma.sample.findUnique({
        where: { id: sampleId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Sample not found');
    }
    const rows = await this.prisma.assetAttachment.findMany({
      where: { sampleId },
      orderBy: { createdAt: 'asc' },
      include: {
        asset: {
          select: {
            id: true,
            type: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
          },
        },
      },
    });
    return rows.map((a) => ({
      attachmentId: a.id,
      assetId: a.asset.id,
      type: a.asset.type,
      originalName: a.asset.originalName,
      mimeType: a.asset.mimeType,
      sizeBytes: a.asset.sizeBytes,
      customerVisible: a.customerVisible,
    }));
  }

  /** Delegates to the asset module so attachment integrity rules live in one place. */
  attachAsset(
    sampleId: string,
    assetId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<AttachmentResponseDto> {
    return this.assets.attach(
      assetId,
      { targetType: 'SAMPLE', targetId: sampleId },
      actor,
      meta,
    );
  }

  /**
   * Staff decision to show a file to the customer. Works in any sample status (mockups and final photos
   * are shared after the request is submitted); the default for every attachment is staff-only.
   */
  async setCustomerVisibility(
    sampleId: string,
    attachmentId: string,
    customerVisible: boolean,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SampleAttachmentDto> {
    const row = await this.prisma.assetAttachment.findFirst({
      where: { id: attachmentId, sampleId, asset: { archivedAt: null } },
      include: { asset: true, sample: { select: { archivedAt: true } } },
    });
    if (!row || row.sample?.archivedAt)
      throw new NotFoundException('Attachment not found');
    if (row.customerVisible !== customerVisible) {
      await this.prisma.$transaction(async (tx) => {
        await tx.assetAttachment.update({
          where: { id: attachmentId },
          data: { customerVisible },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.ASSET_CUSTOMER_VISIBILITY_CHANGED,
            entityType: 'Sample',
            entityId: sampleId,
            metadata: {
              assetId: row.assetId,
              attachmentId,
              customerVisible,
            },
            meta,
          },
          tx,
        );
      });
    }
    return {
      attachmentId,
      assetId: row.assetId,
      type: row.asset.type,
      originalName: row.asset.originalName,
      mimeType: row.asset.mimeType,
      sizeBytes: row.asset.sizeBytes,
      customerVisible,
    };
  }

  /** Attach an uploaded file to the sample AND show it to the customer in one step (any sample status). */
  async shareFile(
    sampleId: string,
    assetId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SampleAttachmentDto> {
    const [sample, asset] = await Promise.all([
      this.prisma.sample.findUnique({ where: { id: sampleId } }),
      this.prisma.asset.findFirst({ where: { id: assetId, archivedAt: null } }),
    ]);
    if (!sample) throw new NotFoundException('Sample not found');
    if (sample.archivedAt) throw new ConflictException('Sample is archived');
    if (!asset) throw new NotFoundException('Asset not found');
    if (!(SAMPLE_ATTACHABLE_TYPES as readonly string[]).includes(asset.type)) {
      throw new BadRequestException(
        `A ${asset.type} file cannot be shown to a customer (allowed: ${SAMPLE_ATTACHABLE_TYPES.join(', ')})`,
      );
    }
    const attachment = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.assetAttachment.findFirst({
        where: { assetId, sampleId },
      });
      const row = existing
        ? await tx.assetAttachment.update({
            where: { id: existing.id },
            data: { customerVisible: true },
          })
        : await tx.assetAttachment.create({
            data: {
              assetId,
              sampleId,
              createdByUserId: actor.id,
              customerVisible: true,
            },
          });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ASSET_CUSTOMER_VISIBILITY_CHANGED,
          entityType: 'Sample',
          entityId: sampleId,
          metadata: {
            assetId,
            attachmentId: row.id,
            customerVisible: true,
            attached: !existing,
          },
          meta,
        },
        tx,
      );
      return row;
    });
    return {
      attachmentId: attachment.id,
      assetId,
      type: asset.type,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      customerVisible: true,
    };
  }

  async detachAsset(
    sampleId: string,
    attachmentId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const row = await this.prisma.assetAttachment.findFirst({
      where: { id: attachmentId, sampleId },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    await this.assets.detach(row.assetId, attachmentId, actor, meta);
  }

  // ---- helpers -----------------------------------------------------------------------------

  /** Parts can only change while the sample is a DRAFT. */
  private async editableSample(sampleId: string) {
    const sample = await this.prisma.sample.findUnique({
      where: { id: sampleId },
    });
    if (!sample) throw new NotFoundException('Sample not found');
    if (sample.archivedAt) throw new ConflictException('Sample is archived');
    if (!isSpecEditable(sample.status)) {
      throw new ConflictException(
        `The specification is locked while the sample is ${sample.status}; request changes or create a revision`,
      );
    }
    return sample;
  }

  /** Re-check under the row lock: the status may have moved since the first read. */
  private async assertStillDraft(
    tx: Prisma.TransactionClient,
    sampleId: string,
  ): Promise<void> {
    const sample = await tx.sample.findUniqueOrThrow({
      where: { id: sampleId },
      select: { status: true },
    });
    if (!isSpecEditable(sample.status)) {
      throw new ConflictException(
        `The specification is locked while the sample is ${sample.status}`,
      );
    }
  }

  private assertSizeUnit(
    width?: number | null,
    height?: number | null,
    unit?: string | null,
  ): void {
    if ((width != null || height != null) && !unit) {
      throw new BadRequestException(
        'unit is required when width or height is given',
      );
    }
  }

  private assertExactlyOne(
    a: unknown,
    b: unknown,
    aName: string,
    bName: string,
  ): void {
    if ((a != null) === (b != null)) {
      throw new BadRequestException(
        `Provide exactly one of ${aName} or ${bName}`,
      );
    }
  }

  private async assertPrintMethod(id: string): Promise<void> {
    const method = await this.prisma.printMethod.findUnique({ where: { id } });
    if (!method || method.archivedAt || !method.isActive) {
      throw new BadRequestException(
        'printMethodId: print method not found or inactive',
      );
    }
  }

  private async assertArtworkUsable(
    artworkId: string,
    sample: { id: string; brandId: string },
  ): Promise<void> {
    const artwork = await this.prisma.artwork.findUnique({
      where: { id: artworkId },
    });
    if (!artwork || artwork.archivedAt)
      throw new BadRequestException('artworkId: artwork not found or archived');
    if (artwork.brandId !== sample.brandId && artwork.sampleId !== sample.id) {
      throw new BadRequestException(
        'artworkId: artwork belongs to a different brand or sample',
      );
    }
  }

  private pick<T extends object, K extends keyof T>(
    source: T,
    keys: K[],
  ): Record<string, unknown> {
    return Object.fromEntries(
      keys
        .filter((k) => source[k] !== undefined)
        .map((k) => [k as string, source[k]]),
    );
  }

  private record(
    tx: Prisma.TransactionClient,
    actor: ActorRef,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record(
      { ...auditActor(actor), action, entityType, entityId, metadata, meta },
      tx,
    );
  }
}
