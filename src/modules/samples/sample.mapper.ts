import type { Prisma } from '../../generated/prisma/client.js';
import { allowedStaffActions } from './sample-state-machine.js';
import type {
  SampleDetailResponseDto,
  SampleListItemDto,
} from './dto/sample.dto.js';

export const sampleListInclude = {
  customer: { select: { id: true, customerNumber: true, displayName: true } },
  brand: { select: { id: true, brandNumber: true, name: true } },
  productType: { select: { id: true, code: true, name: true } },
  fabric: { select: { id: true, code: true, name: true } },
  assignedSales: { select: { id: true, name: true } },
} satisfies Prisma.SampleInclude;

export const sampleDetailInclude = {
  ...sampleListInclude,
  fabricColor: { select: { id: true, name: true, hex: true, pantone: true } },
  sampleSize: {
    select: {
      id: true,
      code: true,
      name: true,
      scale: { select: { code: true } },
    },
  },
  patternVersion: {
    select: {
      id: true,
      versionNumber: true,
      status: true,
      pattern: {
        select: { id: true, code: true, referenceNumber: true, name: true },
      },
    },
  },
  decorations: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { printMethod: { select: { id: true, code: true, name: true } } },
  },
  accessories: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { accessory: { select: { id: true, code: true, name: true } } },
  },
  components: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      componentOption: {
        select: { id: true, code: true, name: true, category: true },
      },
    },
  },
  attachments: {
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
  },
  termsAcceptances: {
    orderBy: { acceptedAt: 'asc' },
    include: {
      termsVersion: {
        select: { id: true, code: true, version: true, title: true },
      },
    },
  },
} satisfies Prisma.SampleInclude;

type ListRow = Prisma.SampleGetPayload<{ include: typeof sampleListInclude }>;
type DetailRow = Prisma.SampleGetPayload<{
  include: typeof sampleDetailInclude;
}>;

export function toSampleListItem(s: ListRow): SampleListItemDto {
  return {
    id: s.id,
    sampleNumber: s.sampleNumber,
    status: s.status,
    paymentState: s.paymentState,
    revisionNumber: s.revisionNumber,
    customer: s.customer,
    brand: s.brand,
    productType: s.productType,
    customProductName: s.customProductName,
    fabric: s.fabric,
    customFabricName: s.customFabricName,
    assignedSales: s.assignedSales,
    submittedAt: s.submittedAt,
    approvedAt: s.approvedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt,
    createdVia: s.createdByCustomerId ? 'CUSTOMER_PORTAL' : 'STAFF',
  };
}

export function toSampleDetail(s: DetailRow): SampleDetailResponseDto {
  return Object.assign(toSampleListItem(s), {
    holdPreviousStatus: s.holdPreviousStatus,
    revisionOfId: s.revisionOfId,
    customProductDescription: s.customProductDescription,
    customFabricDescription: s.customFabricDescription,
    fabricColor: s.fabricColor,
    customColorName: s.customColorName,
    customPantone: s.customPantone,
    customHex: s.customHex,
    fabricProvider: s.fabricProvider,
    gsm: s.gsm,
    sampleSize: s.sampleSize
      ? {
          id: s.sampleSize.id,
          code: s.sampleSize.code,
          name: s.sampleSize.name,
          scaleCode: s.sampleSize.scale.code,
        }
      : null,
    fitMethod: s.fitMethod,
    patternVersion: s.patternVersion
      ? {
          id: s.patternVersion.id,
          versionNumber: s.patternVersion.versionNumber,
          status: s.patternVersion.status,
          patternId: s.patternVersion.pattern.id,
          patternCode: s.patternVersion.pattern.code,
          patternReference: s.patternVersion.pattern.referenceNumber,
          patternName: s.patternVersion.pattern.name,
        }
      : null,
    notes: s.notes,
    fitNotes: s.fitNotes,
    printNotes: s.printNotes,
    fabricNotes: s.fabricNotes,
    specialInstructions: s.specialInstructions,
    factoryInstructions: s.factoryInstructions,
    reviewedAt: s.reviewedAt,
    completedAt: s.completedAt,
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
      artworkId: d.artworkId,
      sortOrder: d.sortOrder,
    })),
    accessories: s.accessories.map((a) => ({
      id: a.id,
      accessory: a.accessory,
      customName: a.customName,
      quantity: a.quantity,
      notes: a.notes,
      sortOrder: a.sortOrder,
    })),
    components: s.components.map((c) => ({
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
    })),
    attachments: s.attachments.map((a) => ({
      attachmentId: a.id,
      assetId: a.asset.id,
      type: a.asset.type,
      originalName: a.asset.originalName,
      mimeType: a.asset.mimeType,
      sizeBytes: a.asset.sizeBytes,
      customerVisible: a.customerVisible,
    })),
    termsAcceptances: s.termsAcceptances.map((t) => ({
      id: t.id,
      termsVersionId: t.termsVersion.id,
      code: t.termsVersion.code,
      version: t.termsVersion.version,
      title: t.termsVersion.title,
      mode: t.mode,
      sourceNote: t.sourceNote,
      acceptedAt: t.acceptedAt,
    })),
    allowedActions: s.archivedAt ? [] : allowedStaffActions(s.status),
  });
}
