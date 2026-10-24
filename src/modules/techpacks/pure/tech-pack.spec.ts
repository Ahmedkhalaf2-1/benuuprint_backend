import {
  buildTechPackContent,
  canonical,
  contentHash,
  redactForFloor,
  type TechPackInput,
} from './tech-pack-content.js';
import { renderTechPackPdf } from './tech-pack-pdf.js';

const snapshot = {
  sample: { sampleNumber: 'SMP-000001', revisionNumber: 1 },
  customer: {
    customerNumber: 'CUS-000001',
    displayName: 'Mona Trading',
    id: 'secret-id',
  },
  brand: { brandNumber: 'BRD-000001', name: 'Nile Wear' },
  product: {
    source: 'CATALOG',
    code: 'HOODIE',
    name: 'Hoodie',
    category: 'TOPS',
  },
  fabric: {
    source: 'CATALOG',
    code: 'FLEECE',
    name: 'Fleece',
    composition: '80% cotton',
    referenceNumber: 'FAB-000001',
  },
  color: {
    source: 'CATALOG',
    name: 'Black',
    pantone: '19-0303',
    hex: '#111111',
  },
  gsm: 320,
  fabricProvider: 'BENUE',
  size: { code: 'M', name: 'Medium' },
  fit: {
    method: 'BENUE_PATTERN',
    patternVersion: {
      referenceNumber: 'PAT-1',
      code: 'HD',
      name: 'Hoodie',
      versionNumber: 2,
      fitType: 'REGULAR',
      files: [{ assetId: 'a1', originalName: 'pat.png', checksum: 'c' }],
    },
    sizeCharts: [],
  },
  decorations: [
    {
      printMethod: { code: 'DTF', name: 'DTF', type: 'PRINT' },
      placement: 'Chest',
      side: 'FRONT',
      width: '10.00',
      height: '8.00',
      unit: 'CM',
      colorCount: 2,
      notes: 'n',
      artworkRequired: true,
      artwork: {
        name: 'Logo',
        purpose: 'MAIN',
        versionNumber: 1,
        file: { assetId: 'a2', originalName: 'logo.png', checksum: 'd' },
      },
    },
  ],
  accessories: [{ code: 'ZIP', name: 'Zip', quantity: 1 }],
  labelsAndPackaging: [{ code: 'LBL', category: 'LABEL', name: 'Neck label' }],
  instructions: { factoryInstructions: 'Double stitch hem', hiddenField: 'x' },
};
const base = (over: Partial<TechPackInput> = {}): TechPackInput => ({
  kind: 'ORDER',
  reference: 'TPK-000001',
  version: 2,
  generatedAt: new Date('2031-01-05T10:00:00Z'),
  spec: {
    id: 's1',
    revision: 1,
    kind: 'APPROVED_REFERENCE',
    specHash: 'a'.repeat(64),
    snapshot,
  },
  order: {
    orderNumber: 'ORD-000007',
    priority: 'HIGH',
    targetDeliveryDate: new Date('2031-02-01T00:00:00Z'),
    spec: {
      id: 'o1',
      revision: 2,
      specHash: 'b'.repeat(64),
      totalQuantity: 100,
      snapshot: {
        items: [
          {
            productName: 'Hoodie',
            quantity: 100,
            variants: [
              {
                size: { name: 'Medium' },
                color: { name: 'Black', pantone: '19-0303' },
                quantity: 60,
              },
              { size: { code: 'L' }, color: { name: 'Black' }, quantity: 40 },
            ],
          },
        ],
      },
    },
  },
  packaging: {
    foldingInstructions: 'Fold',
    polybagRequired: true,
    labelsRequired: true,
    hangTagsRequired: false,
    stickersRequired: false,
    stickerNotes: null,
    unitsPerCarton: 25,
    cartonNotes: null,
    specialInstructions: null,
    components: [{ name: 'Hang tag', quantityPerUnit: 1, notes: null }],
  },
  qcRequirements: [
    {
      stageCode: 'QC_GATE_1',
      stageName: 'QC 1',
      templateCode: 'QC1',
      templateName: 'QC1',
      version: 1,
      items: [
        {
          code: 'A',
          label: 'Dimensions',
          resultType: 'PASS_FAIL',
          required: true,
        },
      ],
    },
  ],
  jobs: [{ jobNumber: 'JOB-000003', status: 'READY' }],
  jobCardUrl: 'https://app.example/q/abc',
  ...over,
});

describe('tech pack content', () => {
  it('is built from the frozen specifications only', () => {
    const c = buildTechPackContent(base());
    expect(c.document).toMatchObject({
      reference: 'TPK-000001',
      version: 2,
      kind: 'ORDER',
      generatedAt: '2031-01-05T10:00:00.000Z',
    });
    expect(c.source.specification).toEqual({
      id: 's1',
      kind: 'APPROVED_REFERENCE',
      revision: 1,
      hash: 'a'.repeat(64),
    });
    expect(c.source.orderSpecification).toEqual({
      id: 'o1',
      revision: 2,
      hash: 'b'.repeat(64),
    });
    expect(c.fabric).toMatchObject({
      name: 'Fleece',
      composition: '80% cotton',
    });
    expect(c.color).toMatchObject({
      name: 'Black',
      pantone: '19-0303',
      hex: '#111111',
    });
    expect(c.gsm).toBe(320);
    expect(c.fabricProvider).toBe('BENUE');
    expect(c.fit.patternVersion).toMatchObject({ versionNumber: 2 });
    expect(c.decorations[0]).toMatchObject({
      placement: 'Chest',
      width: '10.00',
      artwork: { name: 'Logo', file: { assetId: 'a2' } },
    });
    expect(c.order).toMatchObject({
      orderNumber: 'ORD-000007',
      totalQuantity: 100,
      targetDeliveryDate: '2031-02-01',
    });
    expect(c.order!.items[0]!.variants).toEqual([
      { size: 'Medium', color: 'Black', pantone: '19-0303', quantity: 60 },
      { size: 'L', color: 'Black', quantity: 40 },
    ]);
    expect(c.packaging!.unitsPerCarton).toBe(25);
    expect(c.qcRequirements[0]!.items[0]!.label).toBe('Dimensions');
    expect(c.jobCard).toEqual({ url: 'https://app.example/q/abc' });
    expect(JSON.stringify(c)).not.toContain('secret-id'); // internal ids of the customer are not copied
  });
  it('a sample pack has no order section', () => {
    const c = buildTechPackContent(
      base({
        kind: 'SAMPLE',
        order: undefined,
        packaging: null,
        spec: {
          id: 's9',
          revision: 3,
          kind: 'PRE_PRODUCTION',
          specHash: 'c'.repeat(64),
          snapshot,
        },
      }),
    );
    expect(c.order).toBeNull();
    expect(c.source.specification.kind).toBe('PRE_PRODUCTION');
    expect(c.document.title).toBe('Sample production tech pack');
  });
  it('the hash is stable and sensitive to every change', () => {
    const a = contentHash(buildTechPackContent(base()));
    expect(contentHash(buildTechPackContent(base()))).toBe(a);
    expect(contentHash(buildTechPackContent(base({ version: 3 })))).not.toBe(a);
    const other = base();
    (other.spec.snapshot as { gsm: number }).gsm = 330;
    expect(contentHash(buildTechPackContent(other))).not.toBe(a);
    expect(canonical({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(
      '{"a":[2,{"d":1}],"b":1}',
    );
  });
  it('the floor view drops the customer identity and the job-card URL', () => {
    const floor = redactForFloor(buildTechPackContent(base()));
    expect(floor).not.toHaveProperty('customer');
    expect(floor).not.toHaveProperty('jobCard');
    expect(JSON.stringify(floor)).not.toContain('Mona Trading');
    expect(floor.brand.name).toBe('Nile Wear');
  });
});

/** PDFKit writes text as hex strings (WinAnsi in content streams, UTF-16BE in the info dictionary) and splits words for kerning. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const decode = (hex: string) => {
    const bytes = Buffer.from(hex, 'hex');
    return bytes[0] === 0xfe && bytes[1] === 0xff
      ? bytes.subarray(2).swap16().toString('utf16le')
      : bytes.toString('latin1');
  };
  const out: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\]\s*TJ/g))
    out.push(
      [...m[1]!.matchAll(/<([0-9a-fA-F]+)>/g)]
        .map((x) => decode(x[1]!))
        .join(''),
    );
  for (const m of raw.matchAll(/<([0-9a-fA-F]{2,})>\s*Tj/g))
    out.push(decode(m[1]!));
  for (const m of raw.matchAll(
    /\/(?:Title|Author|Subject|Keywords)\s*<([0-9a-fA-F]+)>/g,
  ))
    out.push(decode(m[1]!));
  return `${raw}\n${out.join('\n')}`;
}

describe('tech pack PDF', () => {
  const floor = () => redactForFloor(buildTechPackContent(base()));
  it('is a real PDF with the reference, version and metadata', async () => {
    const pdf = await renderTechPackPdf(floor(), {
      qrUrl: 'https://app.example/q/abc',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf);
    expect(text).toContain('/Title');
    expect(text).toContain('TPK-000001');
    expect(text).toContain('Bulk production tech pack');
    expect(text).toContain('Benue Print');
    expect(text).toMatch(/D:20310105100000Z/);
    expect(text).toContain('ORD-000007');
    expect(text).toContain('Nile Wear');
    expect(text).not.toContain('Mona Trading');
    expect(pdf.length).toBeGreaterThan(2000);
  });
  it('is deterministic: the same content gives the same bytes', async () => {
    const a = await renderTechPackPdf(floor(), {
      qrUrl: 'https://app.example/q/abc',
    });
    const b = await renderTechPackPdf(floor(), {
      qrUrl: 'https://app.example/q/abc',
    });
    expect(a.equals(b)).toBe(true);
    const noQr = await renderTechPackPdf(floor(), { qrUrl: null });
    expect(noQr.equals(a)).toBe(false);
  });
  it('replaces characters Helvetica cannot draw instead of dropping them', async () => {
    const c = buildTechPackContent(base());
    c.brand.name = 'علامة';
    const pdf = await renderTechPackPdf(redactForFloor(c), { qrUrl: null });
    expect(pdfText(pdf)).toContain('?????');
  });
});
