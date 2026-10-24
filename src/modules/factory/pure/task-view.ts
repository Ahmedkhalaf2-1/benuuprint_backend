import type { DepartmentType } from '../../../generated/prisma/client.js';

/**
 * What a factory worker needs to do their stage, derived from the FROZEN production
 * specification (never live master data). Each department sees only the parts of the
 * specification relevant to its work. Customer identity beyond the brand label,
 * quotation/price, payment, terms and approval details are never included.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Snapshot = Record<string, any>;
export type TaskView = Record<string, unknown>;

const pick = (source: Record<string, any> | null | undefined, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((k) => source && source[k] !== undefined)
      .map((k) => [k, source![k]]),
  );

const fileRef = (f: any) =>
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

const product = (s: Snapshot) => ({
  sampleNumber: s.sample?.sampleNumber,
  brand: s.brand?.name,
  product:
    s.product?.source === 'CATALOG'
      ? pick(s.product, ['code', 'name', 'category'])
      : {
          custom: true,
          name: s.product?.name,
          description: s.product?.description,
        },
  size: s.size ? pick(s.size, ['code', 'name']) : null,
});

const fabric = (s: Snapshot) => ({
  fabric:
    s.fabric?.source === 'CATALOG'
      ? pick(s.fabric, ['code', 'name', 'composition'])
      : {
          custom: true,
          name: s.fabric?.name,
          description: s.fabric?.description,
        },
  color: pick(s.color, ['source', 'name', 'internalCode', 'hex', 'pantone']),
  gsm: s.gsm ?? null,
  fabricProvider: s.fabricProvider,
});

const fit = (s: Snapshot) => ({
  method: s.fit?.method,
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
});

const decorations = (s: Snapshot) =>
  (s.decorations ?? []).map((d: any) => ({
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
    printMethod: pick(d.printMethod, ['code', 'name', 'type']),
    artwork: d.artwork
      ? {
          ...pick(d.artwork, ['name', 'purpose', 'versionNumber']),
          file: fileRef(d.artwork.file),
        }
      : null,
  }));

const accessories = (s: Snapshot) =>
  (s.accessories ?? []).map((a: any) =>
    pick(a, ['code', 'name', 'custom', 'quantity', 'notes']),
  );

const labelsAndPackaging = (s: Snapshot) =>
  (s.labelsAndPackaging ?? []).map((c: any) =>
    pick(c, ['code', 'category', 'name', 'custom', 'notes']),
  );

const notes = (s: Snapshot, keys: string[]) => ({
  instructions: pick(s.instructions, keys),
});

export function buildTaskView(
  department: DepartmentType,
  s: Snapshot,
): TaskView {
  const base = product(s);
  switch (department) {
    case 'FABRIC':
      return {
        ...base,
        ...fabric(s),
        ...notes(s, [
          'fabricNotes',
          'specialInstructions',
          'factoryInstructions',
        ]),
      };
    case 'PATTERN':
      return {
        ...base,
        fit: fit(s),
        ...notes(s, ['fitNotes', 'specialInstructions', 'factoryInstructions']),
      };
    case 'CUTTING':
      return {
        ...base,
        ...fabric(s),
        fit: fit(s),
        ...notes(s, [
          'fitNotes',
          'fabricNotes',
          'specialInstructions',
          'factoryInstructions',
        ]),
      };
    case 'PRINTING':
      return {
        ...base,
        color: fabric(s).color,
        decorations: decorations(s),
        ...notes(s, [
          'printNotes',
          'specialInstructions',
          'factoryInstructions',
        ]),
      };
    case 'SEWING':
      return {
        ...base,
        ...fabric(s),
        fit: fit(s),
        accessories: accessories(s),
        labelsAndPackaging: labelsAndPackaging(s).filter(
          (c: any) => c.category !== 'PACKAGING',
        ),
        ...notes(s, ['fitNotes', 'specialInstructions', 'factoryInstructions']),
      };
    case 'PACKAGING':
      return {
        ...base,
        accessories: accessories(s),
        labelsAndPackaging: labelsAndPackaging(s),
        ...notes(s, ['specialInstructions', 'factoryInstructions']),
      };
    case 'QC':
      // Inspectors compare the finished work against the whole production specification.
      return {
        ...base,
        ...fabric(s),
        fit: fit(s),
        decorations: decorations(s),
        accessories: accessories(s),
        labelsAndPackaging: labelsAndPackaging(s),
        ...notes(s, [
          'notes',
          'fitNotes',
          'printNotes',
          'fabricNotes',
          'specialInstructions',
          'factoryInstructions',
        ]),
      };
    default:
      return {
        ...base,
        ...notes(s, ['specialInstructions', 'factoryInstructions']),
      };
  }
}
