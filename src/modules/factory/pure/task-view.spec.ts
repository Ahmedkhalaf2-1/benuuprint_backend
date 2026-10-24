import { buildTaskView } from './task-view.js';

const file = (id: string) => ({
  assetId: id,
  type: 'ARTWORK',
  originalName: `${id}.png`,
  mimeType: 'image/png',
  sizeBytes: 10,
  checksum: 'abc',
  storageKey: 'SECRET',
});

const snapshot = {
  sample: { sampleNumber: 'SMP-000001', id: 's1' },
  customer: {
    id: 'c1',
    customerNumber: 'CUS-000009',
    displayName: 'Secret Customer Co',
  },
  brand: { id: 'b1', brandNumber: 'BRD-000001', name: 'Nile Core' },
  product: {
    source: 'CATALOG',
    code: 'HOODIE',
    name: 'Hoodie',
    category: 'OUTERWEAR',
  },
  fabric: {
    source: 'CATALOG',
    code: 'FRENCH_TERRY',
    name: 'French Terry',
    composition: 'Cotton',
    referenceNumber: 'FAB-000003',
  },
  color: {
    source: 'CATALOG',
    name: 'Navy',
    hex: '#001f3f',
    pantone: '19-3920',
    fabricColorId: 'x',
  },
  fabricProvider: 'CUSTOMER',
  gsm: 280,
  size: { code: 'M', name: 'M', scale: { code: 'STANDARD' } },
  fit: {
    method: 'BENUE_PATTERN',
    patternVersion: {
      referenceNumber: 'PAT-000001',
      code: 'HOODIE_REG',
      name: 'Regular hoodie',
      versionNumber: 2,
      fitType: 'REGULAR',
      files: [file('pat1')],
    },
    sizeCharts: [file('chart1')],
  },
  decorations: [
    {
      placement: 'Chest',
      side: 'FRONT',
      width: '25.00',
      height: '10.00',
      unit: 'CM',
      colorCount: 3,
      notes: 'centered',
      artworkRequired: true,
      printMethod: {
        code: 'DTF',
        name: 'DTF',
        type: 'PRINT',
        printMethodId: 'p',
      },
      artwork: {
        name: 'Logo',
        purpose: 'FRONT_PRINT',
        versionNumber: 1,
        file: file('art1'),
      },
    },
  ],
  accessories: [
    { code: 'ZIP', name: 'Zip', custom: false, quantity: 1, notes: 'metal' },
  ],
  labelsAndPackaging: [
    {
      code: 'NECK_LABEL',
      category: 'LABEL',
      name: 'Neck label',
      custom: false,
    },
    { code: 'POLYBAG', category: 'PACKAGING', name: 'Polybag', custom: false },
  ],
  instructions: {
    notes: 'rush',
    fitNotes: 'loose',
    printNotes: 'no overlap',
    fabricNotes: 'pre-wash',
    specialInstructions: 'careful',
    factoryInstructions: 'use table 2',
  },
  quotation: {
    quotationNumber: 'QTN-000001',
    total: '1000.00',
    currency: 'EGP',
  },
  terms: [{ title: 'Sample terms' }],
  approval: { mode: 'STAFF_RECORDED_ON_BEHALF', sourceNote: 'WhatsApp' },
};

describe('buildTaskView', () => {
  const departments = [
    'FABRIC',
    'PATTERN',
    'CUTTING',
    'PRINTING',
    'SEWING',
    'QC',
    'PACKAGING',
    'GENERAL',
  ] as const;

  it('never exposes customer identity, prices, payments, terms, approvals, storage keys or internal ids', () => {
    for (const d of departments) {
      const dump = JSON.stringify(buildTaskView(d, snapshot));
      expect(dump).not.toMatch(
        /Secret Customer|CUS-0|QTN-|1000\.00|EGP|Sample terms|WhatsApp|STAFF_RECORDED|SECRET|storageKey|fabricColorId|printMethodId|FAB-0000/,
      );
      expect(dump).toContain('Nile Core'); // the brand label is needed on the floor
      expect(dump).toContain('SMP-000001');
    }
  });

  it('gives printing the decorations and approved artwork but not fabric or accessories', () => {
    const v = buildTaskView('PRINTING', snapshot) as any;
    expect(v.decorations).toHaveLength(1);
    expect(v.decorations[0]).toMatchObject({
      placement: 'Chest',
      width: '25.00',
      unit: 'CM',
    });
    expect(v.decorations[0].artwork.file.assetId).toBe('art1');
    expect(v.decorations[0].artwork.file.storageKey).toBeUndefined();
    expect(v.instructions).toEqual({
      printNotes: 'no overlap',
      specialInstructions: 'careful',
      factoryInstructions: 'use table 2',
    });
    expect(v.fabric).toBeUndefined();
    expect(v.accessories).toBeUndefined();
  });

  it('gives fabric the material facts and pattern-making the fit and pattern files', () => {
    const f = buildTaskView('FABRIC', snapshot) as any;
    expect(f.fabric).toMatchObject({
      code: 'FRENCH_TERRY',
      composition: 'Cotton',
    });
    expect(f).toMatchObject({ gsm: 280, fabricProvider: 'CUSTOMER' });
    expect(f.decorations).toBeUndefined();
    expect(f.instructions.fabricNotes).toBe('pre-wash');
    const p = buildTaskView('PATTERN', snapshot) as any;
    expect(p.fit.patternVersion).toMatchObject({
      name: 'Regular hoodie',
      versionNumber: 2,
    });
    expect(p.fit.patternVersion.files[0].assetId).toBe('pat1');
    expect(p.fit.sizeCharts[0].assetId).toBe('chart1');
    expect(p.fabric).toBeUndefined();
    expect(p.instructions.fitNotes).toBe('loose');
  });

  it('gives sewing accessories and labels but not packaging, and packaging the reverse', () => {
    const s = buildTaskView('SEWING', snapshot) as any;
    expect(s.accessories).toHaveLength(1);
    expect(s.labelsAndPackaging.map((c: any) => c.code)).toEqual([
      'NECK_LABEL',
    ]);
    const pk = buildTaskView('PACKAGING', snapshot) as any;
    expect(pk.labelsAndPackaging.map((c: any) => c.code)).toEqual([
      'NECK_LABEL',
      'POLYBAG',
    ]);
    expect(pk.fabric).toBeUndefined();
    expect(pk.decorations).toBeUndefined();
  });

  it('gives QC the whole production specification and a custom product is labelled as such', () => {
    const q = buildTaskView('QC', snapshot) as any;
    for (const key of [
      'fabric',
      'color',
      'fit',
      'decorations',
      'accessories',
      'labelsAndPackaging',
      'instructions',
    ])
      expect(q[key]).toBeDefined();
    expect(q.instructions.notes).toBe('rush');
    const custom = buildTaskView('GENERAL', {
      ...snapshot,
      product: {
        source: 'CUSTOM',
        name: 'Quilted vest',
        description: '3 pockets',
      },
    }) as any;
    expect(custom.product).toEqual({
      custom: true,
      name: 'Quilted vest',
      description: '3 pockets',
    });
  });
});
