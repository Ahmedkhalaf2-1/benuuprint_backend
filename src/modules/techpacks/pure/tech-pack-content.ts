import { createHash } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Snap = Record<string, any>;

/**
 * Tech Pack content. Built ONLY from frozen production truth:
 *   SAMPLE → the sample's PRE_PRODUCTION specification (what the factory builds the physical sample from);
 *   ORDER  → the order's APPROVED_REFERENCE specification + the OrderProductionSpec in force (quantities, size
 *            breakdown, target date).
 * Master data (fabrics, print methods, sizes …) is never read for the document itself, so editing it later
 * cannot change an issued pack. Two things are NOT frozen elsewhere and are therefore snapshotted INTO the
 * content at generation time: the packaging specification of the order and the QC checklists in force.
 */

export interface TechPackInput {
  kind: 'SAMPLE' | 'ORDER';
  reference: string;
  version: number;
  generatedAt: Date;
  spec: {
    id: string;
    revision: number;
    kind: string;
    specHash: string;
    snapshot: Snap;
  };
  order?: {
    orderNumber: string;
    priority: string;
    targetDeliveryDate: Date | null;
    reorderOfOrderNumber?: string | null;
    spec: {
      id: string;
      revision: number;
      specHash: string;
      totalQuantity: number;
      snapshot: Snap;
    };
  };
  packaging?: {
    foldingInstructions: string | null;
    polybagRequired: boolean;
    labelsRequired: boolean;
    hangTagsRequired: boolean;
    stickersRequired: boolean;
    stickerNotes: string | null;
    unitsPerCarton: number | null;
    cartonNotes: string | null;
    specialInstructions: string | null;
    components: {
      name: string;
      quantityPerUnit: number | null;
      notes: string | null;
    }[];
  } | null;
  qcRequirements: {
    stageCode: string;
    stageName: string;
    templateCode: string;
    templateName: string;
    version: number;
    items: {
      code: string;
      label: string;
      resultType: string;
      required: boolean;
    }[];
  }[];
  jobs: { jobNumber: string; status: string; batchNumber?: string | null }[];
  /** URL encoded in the QR of the job card, when the pack points at one job. */
  jobCardUrl?: string | null;
}

const pick = (o: Snap | null | undefined, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o![k]]),
  );
const fileRef = (f: Snap | null | undefined) =>
  f
    ? pick(f, [
        'assetId',
        'type',
        'originalName',
        'mimeType',
        'sizeBytes',
        'checksum',
      ])
    : null;
const day = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString().slice(0, 10) : null;

export function buildTechPackContent(i: TechPackInput) {
  const s = i.spec.snapshot;
  const o = i.order;
  const sizeLabel = (v: Snap) => v.size?.name ?? v.size?.code ?? 'Unspecified';
  const colorLabel = (v: Snap) => v.color?.name ?? 'Unspecified';
  return {
    schemaVersion: 1,
    document: {
      reference: i.reference,
      version: i.version,
      kind: i.kind,
      title:
        i.kind === 'SAMPLE'
          ? 'Sample production tech pack'
          : 'Bulk production tech pack',
      generatedAt: i.generatedAt.toISOString(),
      note: 'Operational document for the factory. It is not a customer approval.',
    },
    source: {
      sampleNumber: s.sample?.sampleNumber ?? null,
      sampleRevision: s.sample?.revisionNumber ?? null,
      orderNumber: o?.orderNumber ?? null,
      specification: {
        id: i.spec.id,
        kind: i.spec.kind,
        revision: i.spec.revision,
        hash: i.spec.specHash,
      },
      orderSpecification: o
        ? { id: o.spec.id, revision: o.spec.revision, hash: o.spec.specHash }
        : null,
    },
    customer: pick(s.customer, ['customerNumber', 'displayName']),
    brand: pick(s.brand, ['brandNumber', 'name']),
    product:
      s.product?.source === 'CATALOG'
        ? pick(s.product, ['code', 'name', 'category'])
        : {
            custom: true,
            name: s.product?.name ?? null,
            description: s.product?.description ?? null,
          },
    fabric:
      s.fabric?.source === 'CATALOG'
        ? pick(s.fabric, ['referenceNumber', 'code', 'name', 'composition'])
        : {
            custom: true,
            name: s.fabric?.name ?? null,
            description: s.fabric?.description ?? null,
          },
    color: pick(s.color, ['source', 'name', 'internalCode', 'hex', 'pantone']),
    gsm: s.gsm ?? null,
    fabricProvider: s.fabricProvider ?? null,
    sampleSize: s.size ? pick(s.size, ['code', 'name']) : null,
    fit: {
      method: s.fit?.method ?? null,
      patternVersion: s.fit?.patternVersion
        ? {
            ...pick(s.fit.patternVersion, [
              'referenceNumber',
              'code',
              'name',
              'versionNumber',
              'fitType',
            ]),
            files: (s.fit.patternVersion.files ?? []).map(fileRef),
          }
        : null,
      sizeCharts: (s.fit?.sizeCharts ?? []).map(fileRef),
    },
    decorations: (s.decorations ?? []).map((d: Snap) => ({
      printMethod: pick(d.printMethod, ['code', 'name', 'type']),
      ...pick(d, [
        'placement',
        'side',
        'width',
        'height',
        'unit',
        'colorCount',
        'notes',
        'artworkRequired',
      ]),
      artwork: d.artwork
        ? {
            ...pick(d.artwork, ['name', 'purpose', 'versionNumber']),
            file: fileRef(d.artwork.file),
          }
        : null,
    })),
    accessories: (s.accessories ?? []).map((a: Snap) =>
      pick(a, ['code', 'name', 'custom', 'quantity', 'notes']),
    ),
    labelsAndPackaging: (s.labelsAndPackaging ?? []).map((c: Snap) =>
      pick(c, ['code', 'category', 'name', 'custom', 'notes']),
    ),
    instructions: s.instructions ?? {},
    order: o
      ? {
          orderNumber: o.orderNumber,
          priority: o.priority,
          targetDeliveryDate: day(o.targetDeliveryDate),
          reorderOf: o.reorderOfOrderNumber ?? null,
          totalQuantity: o.spec.totalQuantity,
          items: (o.spec.snapshot.items ?? []).map((it: Snap) => ({
            productName: it.productName,
            quantity: it.quantity,
            variants: (it.variants ?? []).map((v: Snap) => ({
              size: sizeLabel(v),
              color: colorLabel(v),
              ...(v.color?.pantone ? { pantone: v.color.pantone } : {}),
              ...(v.color?.hex ? { hex: v.color.hex } : {}),
              quantity: v.quantity,
            })),
          })),
        }
      : null,
    packaging: i.packaging ?? null,
    qcRequirements: i.qcRequirements,
    jobs: i.jobs,
    jobCard: i.jobCardUrl ? { url: i.jobCardUrl } : null,
  };
}

export type TechPackContent = ReturnType<typeof buildTechPackContent>;

/** Stable JSON (sorted keys) so the same inputs always hash to the same value. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

export const contentHash = (content: unknown) =>
  createHash('sha256').update(canonical(content)).digest('hex');

/**
 * The floor's view: the same document without the customer's identity (brand label only, like every other
 * floor-facing production view), without the job-card URL and without document metadata they do not need.
 */
export function redactForFloor(content: TechPackContent) {
  const { customer: _customer, jobCard: _jobCard, ...rest } = content;
  void _customer;
  void _jobCard;
  return rest;
}
