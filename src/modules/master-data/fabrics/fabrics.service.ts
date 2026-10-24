import { toPlain } from '../../../common/plain.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { ReferenceService } from '../../../database/reference-sequence.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import {
  MasterDataService,
  type MasterDataListQueryDto,
} from '../master-data.base.js';
import type {
  CreateFabricColorDto,
  CreateFabricDto,
  FabricColorResponseDto,
  FabricResponseDto,
  ListFabricsQueryDto,
  ProductFabricResponseDto,
  SetProductFabricDto,
  UpdateFabricColorDto,
  UpdateFabricDto,
} from './fabric.dto.js';

const fabricInclude = {
  colors: {
    where: { archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  },
  productTypes: {
    include: { productType: { select: { id: true, code: true, name: true } } },
    orderBy: { productType: { name: 'asc' } },
  },
} satisfies Prisma.FabricInclude;

type Row = Prisma.FabricGetPayload<{ include: typeof fabricInclude }>;
type ColorRow = Prisma.FabricColorGetPayload<object>;

const toColor = (c: ColorRow): FabricColorResponseDto => ({
  id: c.id,
  fabricId: c.fabricId,
  name: c.name,
  internalCode: c.internalCode,
  hex: c.hex,
  pantone: c.pantone,
  swatchAssetId: c.swatchAssetId,
  isAvailable: c.isAvailable,
  isActive: c.isActive,
  sortOrder: c.sortOrder,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  archivedAt: c.archivedAt,
});

@Injectable()
export class FabricsService extends MasterDataService<
  Row,
  FabricResponseDto,
  CreateFabricDto,
  UpdateFabricDto
> {
  protected readonly entityType = 'Fabric';
  protected readonly label = 'Fabric';
  protected readonly auditPrefix = 'fabric';

  constructor(
    prisma: PrismaService,
    audit: AuditService,
    private readonly references: ReferenceService,
  ) {
    super(prisma, audit);
  }

  protected delegate = (c: PrismaService | Prisma.TransactionClient) =>
    c.fabric;
  protected override include() {
    return fabricInclude;
  }

  protected toResponse(r: Row): FabricResponseDto {
    return {
      id: r.id,
      referenceNumber: r.referenceNumber,
      code: r.code,
      name: r.name,
      description: r.description,
      composition: r.composition,
      minGsm: r.minGsm,
      maxGsm: r.maxGsm,
      defaultGsm: r.defaultGsm,
      unit: r.unit,
      notes: r.notes,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      colors: r.colors.map((c) => ({
        id: c.id,
        name: c.name,
        hex: c.hex,
        isAvailable: c.isAvailable,
      })),
      productTypes: r.productTypes.map((p) => ({
        productTypeId: p.productTypeId,
        code: p.productType.code,
        name: p.productType.name,
        isRecommended: p.isRecommended,
        isAllowed: p.isAllowed,
        notes: p.notes,
      })),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
    };
  }

  protected createData(d: CreateFabricDto) {
    return toPlain(d);
  }

  protected updateData(d: UpdateFabricDto) {
    return Object.assign(toPlain(d), { name: d.name ?? undefined });
  }

  protected override async beforeCreate(
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>,
  ) {
    return { ...data, referenceNumber: await this.references.next('FAB', tx) };
  }

  protected override validate(m: Record<string, unknown>): void {
    const { minGsm, maxGsm, defaultGsm } = m as Record<
      string,
      number | null | undefined
    >;
    if (minGsm != null && maxGsm != null && minGsm > maxGsm) {
      throw new BadRequestException('minGsm cannot exceed maxGsm');
    }
    if (defaultGsm != null) {
      if (minGsm != null && defaultGsm < minGsm)
        throw new BadRequestException('defaultGsm is below minGsm');
      if (maxGsm != null && defaultGsm > maxGsm)
        throw new BadRequestException('defaultGsm is above maxGsm');
    }
  }

  protected override extraWhere(query: MasterDataListQueryDto) {
    const { productTypeId } = query as ListFabricsQueryDto;
    return productTypeId
      ? { productTypes: { some: { productTypeId, isAllowed: true } } }
      : {};
  }

  // ---- colours -----------------------------------------------------------

  async listColors(
    fabricId: string,
    includeArchived = false,
  ): Promise<FabricColorResponseDto[]> {
    await this.findOrThrow(fabricId, true);
    const rows = await this.prisma.fabricColor.findMany({
      where: { fabricId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toColor);
  }

  async createColor(
    fabricId: string,
    dto: CreateFabricColorDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<FabricColorResponseDto> {
    await this.findOrThrow(fabricId);
    await this.assertColorNameFree(fabricId, dto.name);
    if (dto.swatchAssetId) await this.assertSwatch(dto.swatchAssetId);
    const row = await this.prisma.$transaction(async (tx) => {
      const color = await tx.fabricColor.create({
        data: Object.assign(toPlain(dto), { fabricId }),
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'fabric_color.created',
          entityType: 'FabricColor',
          entityId: color.id,
          metadata: {
            fabricId,
            name: color.name,
            hex: color.hex,
            pantone: color.pantone,
          },
          meta,
        },
        tx,
      );
      return color;
    });
    return toColor(row);
  }

  async updateColor(
    id: string,
    dto: UpdateFabricColorDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<FabricColorResponseDto> {
    const existing = await this.findColor(id);
    if (dto.name && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertColorNameFree(existing.fabricId, dto.name, id);
    }
    if (dto.swatchAssetId) await this.assertSwatch(dto.swatchAssetId);
    const data = Object.fromEntries(
      Object.entries(
        Object.assign(toPlain(dto), { name: dto.name ?? undefined }),
      ).filter(([, v]) => v !== undefined),
    );
    const row = await this.prisma.$transaction(async (tx) => {
      const color = await tx.fabricColor.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'fabric_color.updated',
          entityType: 'FabricColor',
          entityId: id,
          metadata: { fabricId: existing.fabricId, fields: Object.keys(data) },
          meta,
        },
        tx,
      );
      return color;
    });
    return toColor(row);
  }

  async archiveColor(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.findColor(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.fabricColor.update({
        where: { id },
        data: { archivedAt: new Date(), isActive: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'fabric_color.archived',
          entityType: 'FabricColor',
          entityId: id,
          metadata: { fabricId: existing.fabricId, name: existing.name },
          meta,
        },
        tx,
      );
    });
  }

  // ---- product compatibility ---------------------------------------------

  async listProductFabrics(
    productTypeId: string,
  ): Promise<ProductFabricResponseDto[]> {
    await this.assertProductType(productTypeId);
    const rows = await this.prisma.productTypeFabric.findMany({
      where: { productTypeId, fabric: { archivedAt: null } },
      include: { fabric: { select: { code: true, name: true } } },
      orderBy: [{ isRecommended: 'desc' }, { fabric: { name: 'asc' } }],
    });
    return rows.map((r) => ({
      productTypeId: r.productTypeId,
      fabricId: r.fabricId,
      fabricCode: r.fabric.code,
      fabricName: r.fabric.name,
      isRecommended: r.isRecommended,
      isAllowed: r.isAllowed,
      notes: r.notes,
    }));
  }

  async setProductFabric(
    productTypeId: string,
    fabricId: string,
    dto: SetProductFabricDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ProductFabricResponseDto> {
    await this.assertProductType(productTypeId);
    const fabric = await this.findOrThrow(fabricId);
    const row = await this.prisma.$transaction(async (tx) => {
      const data = {
        isRecommended: dto.isRecommended,
        isAllowed: dto.isAllowed,
        notes: dto.notes,
      };
      const saved = await tx.productTypeFabric.upsert({
        where: { productTypeId_fabricId: { productTypeId, fabricId } },
        create: { productTypeId, fabricId, ...data },
        update: data,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PRODUCT_TYPE_FABRIC_SET,
          entityType: 'ProductType',
          entityId: productTypeId,
          metadata: {
            fabricId,
            fabricCode: fabric.code,
            isRecommended: saved.isRecommended,
            isAllowed: saved.isAllowed,
          },
          meta,
        },
        tx,
      );
      return saved;
    });
    return {
      productTypeId,
      fabricId,
      fabricCode: fabric.code,
      fabricName: fabric.name,
      isRecommended: row.isRecommended,
      isAllowed: row.isAllowed,
      notes: row.notes,
    };
  }

  async removeProductFabric(
    productTypeId: string,
    fabricId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.prisma.productTypeFabric.findUnique({
      where: { productTypeId_fabricId: { productTypeId, fabricId } },
    });
    if (!existing) throw new NotFoundException('Compatibility entry not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.productTypeFabric.delete({
        where: { productTypeId_fabricId: { productTypeId, fabricId } },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PRODUCT_TYPE_FABRIC_REMOVED,
          entityType: 'ProductType',
          entityId: productTypeId,
          metadata: { fabricId },
          meta,
        },
        tx,
      );
    });
  }

  // ---- helpers -----------------------------------------------------------

  private async findColor(id: string): Promise<ColorRow> {
    const row = await this.prisma.fabricColor.findFirst({
      where: { id, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Fabric color not found');
    return row;
  }

  private async assertColorNameFree(
    fabricId: string,
    name: string,
    exceptId?: string,
  ) {
    const clash = await this.prisma.fabricColor.findFirst({
      where: {
        fabricId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        id: { not: exceptId },
      },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException(
        `This fabric already has a colour named "${name}"`,
      );
  }

  private async assertSwatch(assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, archivedAt: null },
      select: { type: true, mimeType: true },
    });
    if (!asset) throw new BadRequestException('Swatch asset not found');
    if (
      asset.type !== 'FABRIC_SWATCH' ||
      !asset.mimeType.startsWith('image/')
    ) {
      throw new BadRequestException(
        'Swatch asset must be an image of type FABRIC_SWATCH',
      );
    }
  }

  private async assertProductType(id: string) {
    const pt = await this.prisma.productType.findFirst({
      where: { id, archivedAt: null },
      select: { id: true },
    });
    if (!pt) throw new NotFoundException('Product type not found');
  }
}
