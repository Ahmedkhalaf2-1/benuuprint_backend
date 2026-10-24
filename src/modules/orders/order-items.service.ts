import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../../common/canonical-json.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import type {
  Order,
  OrderProductionSpec,
  Prisma,
  SampleProductionSpec,
} from '../../generated/prisma/client.js';
import type { OrderItemInputDto } from './dto/order.dto.js';

type Tx = Prisma.TransactionClient;

export interface ReferenceInfo {
  spec: SampleProductionSpec;
  productName: string;
  sampleNumber: string;
}

const itemsInclude = {
  variants: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.OrderItemInclude;
export type ItemRow = Prisma.OrderItemGetPayload<{
  include: typeof itemsInclude;
}>;

/**
 * Items and variants of an order: validation against the approved reference, diff-based writes
 * (existing ids are updated in place, so history that points at a variant stays valid), the
 * confirmation checks and the frozen order specification.
 */
@Injectable()
export class OrderItemsService {
  /** The approved reference must really be an APPROVED_REFERENCE and still match its hash. */
  async reference(tx: Tx, specId: string): Promise<ReferenceInfo> {
    const spec = await tx.sampleProductionSpec.findUniqueOrThrow({
      where: { id: specId },
    });
    if (spec.kind !== 'APPROVED_REFERENCE') {
      throw new ConflictException(
        'Bulk production must use the APPROVED_REFERENCE, never a pre-production specification',
      );
    }
    if (sha256Hex(canonicalJson(spec.snapshot)) !== spec.specHash) {
      throw new ConflictException(
        'The approved reference failed its integrity check',
      );
    }
    const snap = spec.snapshot as {
      product?: { name?: string };
      sample?: { sampleNumber?: string };
    };
    return {
      spec,
      productName: snap.product?.name ?? 'Product',
      sampleNumber: snap.sample?.sampleNumber ?? '',
    };
  }

  loadItems(tx: Tx, orderId: string): Promise<ItemRow[]> {
    return tx.orderItem.findMany({
      where: { orderId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: itemsInclude,
    });
  }

  // ───────────────────────── validation ─────────────────────────

  private variantKey(v: {
    sizeOptionId?: string | null;
    customSizeName?: string | null;
    fabricColorId?: string | null;
    customColorName?: string | null;
    pantone?: string | null;
  }): string {
    return [
      v.sizeOptionId ?? `c:${(v.customSizeName ?? '').toLowerCase()}`,
      v.fabricColorId ?? `c:${(v.customColorName ?? '').toLowerCase()}`,
      (v.pantone ?? '').toLowerCase(),
    ].join('|');
  }

  /**
   * Per-row rules that hold even for a DRAFT. Totals are NOT checked here (a draft may be
   * incomplete); they are verified, on the server, at confirmation.
   */
  async validate(
    tx: Tx,
    ref: ReferenceInfo,
    items: OrderItemInputDto[],
  ): Promise<void> {
    const sizeIds = new Set<string>();
    const colorIds = new Set<string>();
    items.forEach((item, ii) => {
      const seen = new Set<string>();
      item.variants.forEach((v, vi) => {
        const at = `items[${ii}].variants[${vi}]`;
        if (v.sizeOptionId && v.customSizeName)
          throw new BadRequestException(
            `${at}: use a catalogue size or a custom size name, not both`,
          );
        if (v.fabricColorId && v.customColorName)
          throw new BadRequestException(
            `${at}: use a catalogue colour or a custom colour name, not both`,
          );
        if (
          !v.sizeOptionId &&
          !v.customSizeName &&
          !v.fabricColorId &&
          !v.customColorName
        )
          throw new BadRequestException(`${at}: give a size, a colour or both`);
        if (v.sizeOptionId) sizeIds.add(v.sizeOptionId);
        if (v.fabricColorId) colorIds.add(v.fabricColorId);
        const key = this.variantKey(v);
        if (seen.has(key))
          throw new BadRequestException(
            `${at}: the same size / colour combination appears twice in this item`,
          );
        seen.add(key);
      });
    });
    if (sizeIds.size) {
      const found = await tx.sizeOption.findMany({
        where: { id: { in: [...sizeIds] }, isActive: true, archivedAt: null },
        select: { id: true },
      });
      if (found.length !== sizeIds.size)
        throw new BadRequestException(
          'A size option does not exist or is inactive',
        );
    }
    if (colorIds.size) {
      const found = await tx.fabricColor.findMany({
        where: { id: { in: [...colorIds] }, isActive: true, archivedAt: null },
        select: { id: true, fabricId: true },
      });
      if (found.length !== colorIds.size)
        throw new BadRequestException('A colour does not exist or is inactive');
      // A colour of another fabric would be a different material: that needs a new sample.
      if (found.some((c) => c.fabricId !== ref.spec.fabricId)) {
        throw new BadRequestException(
          'A colour belongs to a different fabric than the approved sample; a fabric change needs a new sample and approval',
        );
      }
    }
  }

  // ───────────────────────── writes ─────────────────────────

  /**
   * Make the order's items and variants equal to `items`. Rows with an id are updated in place,
   * rows without are created, rows missing from the payload are removed.
   */
  async replace(
    tx: Tx,
    order: Pick<Order, 'id' | 'approvedProductionSpecId'>,
    ref: ReferenceInfo,
    items: OrderItemInputDto[],
  ): Promise<void> {
    const existing = await this.loadItems(tx, order.id);
    const existingItems = new Map(existing.map((i) => [i.id, i]));
    const keepItems = new Set<string>();
    const keepVariants = new Set<string>();
    let itemOrder = 0;
    for (const input of items) {
      let itemId = input.id;
      if (itemId) {
        if (!existingItems.has(itemId))
          throw new BadRequestException(
            `Item ${itemId} does not belong to this order`,
          );
        await tx.orderItem.update({
          where: { id: itemId },
          data: {
            quantity: input.quantity,
            notes: input.notes ?? null,
            sortOrder: itemOrder,
          },
        });
      } else {
        const created = await tx.orderItem.create({
          data: {
            orderId: order.id,
            approvedProductionSpecId: order.approvedProductionSpecId,
            productNameSnapshot: ref.productName,
            productTypeId: ref.spec.productTypeId,
            quantity: input.quantity,
            notes: input.notes,
            sortOrder: itemOrder,
          },
        });
        itemId = created.id;
      }
      keepItems.add(itemId);
      itemOrder += 1;
      const ownVariants = new Map(
        (existingItems.get(itemId)?.variants ?? []).map((v) => [v.id, v]),
      );
      let variantOrder = 0;
      for (const v of input.variants) {
        const data = {
          sizeOptionId: v.sizeOptionId ?? null,
          customSizeName: v.customSizeName ?? null,
          fabricColorId: v.fabricColorId ?? null,
          customColorName: v.customColorName ?? null,
          pantone: v.pantone ?? null,
          hex: v.hex ?? null,
          quantity: v.quantity,
          notes: v.notes ?? null,
          sortOrder: variantOrder,
        };
        variantOrder += 1;
        if (v.id) {
          if (!ownVariants.has(v.id))
            throw new BadRequestException(
              `Variant ${v.id} does not belong to its item`,
            );
          await tx.orderVariant.update({ where: { id: v.id }, data });
          keepVariants.add(v.id);
        } else {
          const created = await tx.orderVariant.create({
            data: { orderItemId: itemId, ...data },
          });
          keepVariants.add(created.id);
        }
      }
    }
    const dropVariants = existing
      .flatMap((i) => i.variants)
      .filter((v) => !keepVariants.has(v.id));
    const dropItems = existing.filter((i) => !keepItems.has(i.id));
    try {
      if (dropVariants.length)
        await tx.orderVariant.deleteMany({
          where: { id: { in: dropVariants.map((v) => v.id) } },
        });
      if (dropItems.length)
        await tx.orderItem.deleteMany({
          where: { id: { in: dropItems.map((i) => i.id) } },
        });
    } catch {
      throw new ConflictException(
        'A removed variant is referenced by batches or production reports and cannot be deleted',
      );
    }
  }

  // ───────────────────────── confirmation ─────────────────────────

  /** Completeness checks, computed from the stored rows (never from client totals). */
  assertConfirmable(rows: ItemRow[]): number {
    if (rows.length === 0)
      throw new ConflictException('The order has no items');
    let total = 0;
    rows.forEach((item, i) => {
      if (item.variants.length === 0)
        throw new ConflictException(
          `Item ${i + 1} has no variants (size / colour breakdown)`,
        );
      const sum = item.variants.reduce((s, v) => s + v.quantity, 0);
      if (item.quantity <= 0)
        throw new ConflictException(
          `Item ${i + 1} must have a positive quantity`,
        );
      if (sum !== item.quantity)
        throw new ConflictException(
          `Item ${i + 1}: the variants add up to ${sum} but the item quantity is ${item.quantity}`,
        );
      if (item.variants.some((v) => v.quantity <= 0))
        throw new ConflictException(
          `Item ${i + 1}: every variant needs a positive quantity`,
        );
      total += sum;
    });
    return total;
  }

  /** Freeze approved baseline + order-specific production choices (append-only). */
  async freeze(
    tx: Tx,
    order: Order,
    ref: ReferenceInfo,
    rows: ItemRow[],
    actor: AuthUser,
  ): Promise<OrderProductionSpec> {
    const total = this.assertConfirmable(rows);
    const sizeIds = rows.flatMap((i) =>
      i.variants.map((v) => v.sizeOptionId).filter((x): x is string => !!x),
    );
    const colorIds = rows.flatMap((i) =>
      i.variants.map((v) => v.fabricColorId).filter((x): x is string => !!x),
    );
    const [sizes, colors, latest, reorderOf, builtBy] = await Promise.all([
      tx.sizeOption.findMany({
        where: { id: { in: sizeIds } },
        select: { id: true, code: true, name: true },
      }),
      tx.fabricColor.findMany({
        where: { id: { in: colorIds } },
        select: {
          id: true,
          name: true,
          hex: true,
          pantone: true,
          internalCode: true,
        },
      }),
      tx.orderProductionSpec.aggregate({
        where: { orderId: order.id },
        _max: { revision: true },
      }),
      order.reorderOfOrderId
        ? tx.order.findUnique({
            where: { id: order.reorderOfOrderId },
            select: { orderNumber: true },
          })
        : null,
      ref.spec.sourceFactoryJobId
        ? tx.factoryJob.findUnique({
            where: { id: ref.spec.sourceFactoryJobId },
            select: { jobNumber: true },
          })
        : null,
    ]);
    const size = new Map(sizes.map((s) => [s.id, s]));
    const color = new Map(colors.map((c) => [c.id, c]));
    const revision = (latest._max.revision ?? 0) + 1;
    const snapshot = {
      schemaVersion: 1,
      order: {
        orderNumber: order.orderNumber,
        revision,
        priority: order.priority,
        targetDeliveryDate: order.targetDeliveryDate,
        reorderOfOrderNumber: reorderOf?.orderNumber ?? null,
      },
      reference: {
        approvedProductionSpecId: ref.spec.id,
        revision: ref.spec.revision,
        specHash: ref.spec.specHash,
        sampleNumber: ref.sampleNumber,
        sourceFactoryJobNumber: builtBy?.jobNumber ?? null,
      },
      totalQuantity: total,
      items: rows.map((i) => ({
        itemId: i.id,
        productName: i.productNameSnapshot,
        quantity: i.quantity,
        notes: i.notes,
        variants: i.variants.map((v) => ({
          variantId: v.id,
          size: v.sizeOptionId
            ? {
                source: 'CATALOG',
                code: size.get(v.sizeOptionId)?.code,
                name: size.get(v.sizeOptionId)?.name,
              }
            : v.customSizeName
              ? { source: 'CUSTOM', name: v.customSizeName }
              : null,
          color: v.fabricColorId
            ? {
                source: 'CATALOG',
                name: color.get(v.fabricColorId)?.name,
                internalCode: color.get(v.fabricColorId)?.internalCode ?? null,
                hex: color.get(v.fabricColorId)?.hex ?? null,
                pantone: color.get(v.fabricColorId)?.pantone ?? null,
              }
            : v.customColorName
              ? {
                  source: 'CUSTOM',
                  name: v.customColorName,
                  pantone: v.pantone,
                  hex: v.hex,
                }
              : null,
          quantity: v.quantity,
          notes: v.notes,
        })),
      })),
    };
    return tx.orderProductionSpec.create({
      data: {
        orderId: order.id,
        revision,
        approvedProductionSpecId: ref.spec.id,
        totalQuantity: total,
        specHash: sha256Hex(canonicalJson(snapshot)),
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
        createdByUserId: actor.id,
      },
    });
  }
}
