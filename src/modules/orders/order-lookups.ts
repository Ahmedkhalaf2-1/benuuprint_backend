import type { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

type Client = PrismaService | Prisma.TransactionClient;

interface VariantLike {
  id: string;
  sizeOptionId: string | null;
  customSizeName: string | null;
  fabricColorId: string | null;
  customColorName: string | null;
}

export interface VariantNames {
  size: string | null;
  color: string | null;
  label: string;
}

/** Display names for variants (size / colour), looked up in two batched queries. */
export async function variantNames(
  client: Client,
  variants: VariantLike[],
): Promise<Map<string, VariantNames>> {
  const sizeIds = [
    ...new Set(
      variants.map((v) => v.sizeOptionId).filter((x): x is string => !!x),
    ),
  ];
  const colorIds = [
    ...new Set(
      variants.map((v) => v.fabricColorId).filter((x): x is string => !!x),
    ),
  ];
  const [sizes, colors] = await Promise.all([
    sizeIds.length
      ? client.sizeOption.findMany({
          where: { id: { in: sizeIds } },
          select: { id: true, name: true },
        })
      : [],
    colorIds.length
      ? client.fabricColor.findMany({
          where: { id: { in: colorIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const sizeName = new Map(sizes.map((s) => [s.id, s.name]));
  const colorName = new Map(colors.map((c) => [c.id, c.name]));
  return new Map(
    variants.map((v) => {
      const size = v.sizeOptionId
        ? (sizeName.get(v.sizeOptionId) ?? null)
        : v.customSizeName;
      const color = v.fabricColorId
        ? (colorName.get(v.fabricColorId) ?? null)
        : v.customColorName;
      return [
        v.id,
        {
          size,
          color,
          label: [color, size].filter(Boolean).join(' / ') || 'Variant',
        },
      ];
    }),
  );
}
