import type { PrismaClient } from '../../generated/prisma/client.js';
import { nextReference } from '../reference-sequence.js';

/**
 * Reference master data. Create-if-missing, keyed by `code`: re-running never
 * duplicates rows and never overwrites what admins have since edited. Values
 * such as GSM ranges are starting points for Benue Print to curate.
 */

const PRODUCT_TYPES = [
  ['TEE', 'Tee', 'TOPS'],
  ['POLO', 'Polo', 'TOPS'],
  ['HOODIE', 'Hoodie', 'OUTERWEAR'],
  ['CREWNECK', 'Crewneck', 'TOPS'],
  ['PANTS', 'Pants', 'BOTTOMS'],
  ['SHORTS', 'Shorts', 'BOTTOMS'],
  ['JACKET', 'Jacket', 'OUTERWEAR'],
  ['QUARTER_ZIP', 'Quarter Zip', 'TOPS'],
  ['SHIRT', 'Shirt', 'TOPS'],
  ['TANK', 'Tank', 'TOPS'],
  ['CROP_TOP', 'Crop Top', 'TOPS'],
  ['DRESS', 'Dress', 'DRESSES'],
  ['CAP', 'Cap', 'HEADWEAR'],
] as const;

interface FabricSeed {
  code: string;
  name: string;
  description?: string;
  composition?: string;
  minGsm?: number;
  maxGsm?: number;
  defaultGsm?: number;
}

const FABRICS: FabricSeed[] = [
  { code: 'MILTON', name: 'Milton' },
  { code: 'SUMMER_MILTON', name: 'Summer Milton' },
  { code: 'BOULEVARD', name: 'Boulevard' },
  { code: 'PARASOLA', name: 'Parasola' },
  {
    code: 'SINGLE_LYCRA',
    name: 'Single Lycra',
    composition: 'Cotton / elastane',
    minGsm: 140,
    maxGsm: 200,
    defaultGsm: 160,
  },
  {
    code: 'FRENCH_TERRY',
    name: 'French Terry',
    composition: 'Cotton',
    minGsm: 220,
    maxGsm: 380,
    defaultGsm: 280,
  },
  {
    code: 'LINEN',
    name: 'Linen',
    composition: 'Linen',
    minGsm: 120,
    maxGsm: 220,
  },
  { code: 'WATERPROOF', name: 'Waterproof' },
  { code: 'GABARDINE', name: 'Gabardine', minGsm: 200, maxGsm: 300 },
  { code: 'RUSSETA', name: 'Russeta' },
  {
    code: 'BEKA_POLO',
    name: 'Beka / Polo',
    description: 'Piqué-style knit used for polos',
  },
  {
    code: 'INTERLOCK',
    name: 'Interlock',
    composition: 'Cotton',
    minGsm: 160,
    maxGsm: 240,
  },
  {
    code: 'OTHER_NOT_SURE',
    name: 'Other / Not Sure',
    description:
      'Customer is unsure or wants a fabric not in the list; sales will advise',
  },
];

const FABRIC_PRODUCT_HINTS: [
  fabric: string,
  product: string,
  recommended: boolean,
][] = [
  ['FRENCH_TERRY', 'HOODIE', true],
  ['FRENCH_TERRY', 'CREWNECK', true],
  ['BEKA_POLO', 'POLO', true],
  ['SINGLE_LYCRA', 'TEE', true],
  ['WATERPROOF', 'JACKET', true],
  ['GABARDINE', 'PANTS', true],
  ['GABARDINE', 'SHORTS', true],
  ['GABARDINE', 'JACKET', false],
];

const PRINT_METHODS = [
  ['DTF', 'DTF', 'PRINT', true, null],
  ['VINYL', 'Vinyl', 'PRINT', false, 3],
  ['SCREEN_PRINT', 'Screen Print', 'PRINT', false, 6],
  ['PUFF_PRINT', 'Puff Print', 'PRINT', false, 2],
  ['EMBROIDERY', 'Embroidery', 'EMBROIDERY', false, 12],
] as const;

const ACCESSORIES = [
  ['ZIP', 'Zip', 'Hardware'],
  ['DRAWCORD', 'Drawcord', 'Trim'],
  ['PATCH', 'Patch', 'Decoration'],
  ['BUTTON', 'Button', 'Hardware'],
  ['RIB', 'Rib', 'Trim'],
  ['ELASTIC', 'Elastic', 'Trim'],
  ['LABEL', 'Label', 'Branding'],
] as const;

const COMPONENTS = [
  ['LABEL', 'NECK_LABEL', 'Neck label'],
  ['LABEL', 'CARE_LABEL', 'Care label'],
  ['LABEL', 'SIZE_LABEL', 'Size label'],
  ['LABEL', 'HANG_TAG', 'Hang tag'],
  ['PACKAGING', 'POLYBAG', 'Polybag'],
  ['PACKAGING', 'BOX', 'Box'],
  ['PACKAGING', 'CUSTOM_PACKAGING', 'Custom packaging'],
] as const;

const SIZES = [
  ['XXS', 'XXS'],
  ['XS', 'XS'],
  ['S', 'S'],
  ['M', 'M'],
  ['L', 'L'],
  ['XL', 'XL'],
  ['XXL', 'XXL'],
  ['ONE_SIZE', 'One Size'],
] as const;

export async function seedMasterData(prisma: PrismaClient): Promise<void> {
  for (const [i, [code, name, category]] of PRODUCT_TYPES.entries()) {
    await prisma.productType.upsert({
      where: { code },
      create: { code, name, category, sortOrder: (i + 1) * 10 },
      update: {},
    });
  }

  for (const [i, f] of FABRICS.entries()) {
    const existing = await prisma.fabric.findUnique({
      where: { code: f.code },
    });
    if (existing) continue;
    await prisma.$transaction(async (tx) => {
      await tx.fabric.create({
        data: {
          ...f,
          sortOrder: (i + 1) * 10,
          referenceNumber: await nextReference(tx, 'FAB'),
        },
      });
    });
  }

  const productByCode = new Map(
    (await prisma.productType.findMany()).map((p) => [p.code, p.id]),
  );
  const fabricByCode = new Map(
    (await prisma.fabric.findMany()).map((f) => [f.code, f.id]),
  );
  for (const [fabric, product, isRecommended] of FABRIC_PRODUCT_HINTS) {
    const fabricId = fabricByCode.get(fabric);
    const productTypeId = productByCode.get(product);
    if (!fabricId || !productTypeId) continue;
    await prisma.productTypeFabric.upsert({
      where: { productTypeId_fabricId: { productTypeId, fabricId } },
      create: { productTypeId, fabricId, isRecommended },
      update: {},
    });
  }

  for (const [
    i,
    [code, name, type, supportsFullColor, maxColors],
  ] of PRINT_METHODS.entries()) {
    await prisma.printMethod.upsert({
      where: { code },
      create: {
        code,
        name,
        type,
        supportsFullColor,
        maxColors,
        sortOrder: (i + 1) * 10,
      },
      update: {},
    });
  }

  for (const [i, [code, name, category]] of ACCESSORIES.entries()) {
    await prisma.accessory.upsert({
      where: { code },
      create: { code, name, category, sortOrder: (i + 1) * 10 },
      update: {},
    });
  }

  for (const [i, [category, code, name]] of COMPONENTS.entries()) {
    await prisma.componentOption.upsert({
      where: { code },
      create: { category, code, name, sortOrder: (i + 1) * 10 },
      update: {},
    });
  }

  const scale = await prisma.sizeScale.upsert({
    where: { code: 'STANDARD' },
    create: { code: 'STANDARD', name: 'Standard adult sizes', sortOrder: 10 },
    update: {},
  });
  for (const [i, [code, name]] of SIZES.entries()) {
    await prisma.sizeOption.upsert({
      where: { scaleId_code: { scaleId: scale.id, code } },
      create: { scaleId: scale.id, code, name, sortOrder: (i + 1) * 10 },
      update: {},
    });
  }
}

/**
 * Placeholder sample terms so the submission flow can be exercised. The text is NOT
 * legal content: Benue Print must publish its real terms as a new version
 * (POST /admin/terms) and activate it.
 */
export async function seedSampleTerms(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.termsVersion.findUnique({
    where: { code_version: { code: 'SAMPLE_TERMS', version: 1 } },
  });
  if (existing) return;
  const anyActive = await prisma.termsVersion.findFirst({
    where: { code: 'SAMPLE_TERMS', isActive: true },
  });
  await prisma.termsVersion.create({
    data: {
      code: 'SAMPLE_TERMS',
      version: 1,
      title: 'Sample terms (placeholder, to be confirmed by Benue Print)',
      content:
        'PLACEHOLDER: replace with the approved sample terms and conditions before go-live.',
      // Never steal activation from a version an admin already activated.
      isActive: !anyActive,
    },
  });
}
