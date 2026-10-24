import {
  collectSubmissionProblems,
  type SubmissionInput,
} from './sample-submission.validator.js';

const base = (): SubmissionInput => ({
  sampleId: 's1',
  customerId: 'c1',
  brandId: 'b1',
  customer: { displayName: 'Nile Co', status: 'ACTIVE' },
  brand: { name: 'Core', customerId: 'c1', archivedAt: null },
  productTypeId: 'pt1',
  customProductName: null,
  productType: { name: 'Hoodie', isActive: true, archivedAt: null },
  fabricId: 'f1',
  customFabricName: null,
  fabric: {
    name: 'French Terry',
    isActive: true,
    archivedAt: null,
    minGsm: 220,
    maxGsm: 380,
  },
  fabricColorId: 'col1',
  customColorName: null,
  customPantone: null,
  customHex: null,
  fabricColor: {
    fabricId: 'f1',
    isActive: true,
    isAvailable: true,
    archivedAt: null,
  },
  gsm: 280,
  sampleSizeOptionId: 'sz1',
  sampleSize: { isActive: true, archivedAt: null },
  fitMethod: 'BENUE_PATTERN',
  patternVersionId: 'pv1',
  patternVersion: {
    status: 'APPROVED',
    pattern: { archivedAt: null, productTypeId: 'pt1', name: 'Regular Hoodie' },
  },
  decorations: [],
  attachments: [],
  acceptedTermsVersionIds: ['t1'],
  activeTerms: { id: 't1', version: 1 },
});

describe('collectSubmissionProblems', () => {
  it('accepts a complete sample', () => {
    expect(collectSubmissionProblems(base())).toEqual([]);
  });

  it('accepts custom product, custom fabric and custom color instead of master data', () => {
    const s = base();
    Object.assign(s, {
      productTypeId: null,
      productType: null,
      customProductName: 'Quilted vest',
      fabricId: null,
      fabric: null,
      customFabricName: 'Customer-supplied wool blend',
      fabricColorId: null,
      fabricColor: null,
      customPantone: '19-4052 TCX',
      gsm: 300,
      fitMethod: 'COPY_CUSTOMER_PIECE',
      patternVersionId: null,
      patternVersion: null,
    });
    expect(collectSubmissionProblems(s)).toEqual([]);
  });

  it('reports every missing piece at once', () => {
    const s = base();
    Object.assign(s, {
      productTypeId: null,
      productType: null,
      fabricId: null,
      fabric: null,
      fabricColorId: null,
      fabricColor: null,
      sampleSizeOptionId: null,
      sampleSize: null,
      patternVersionId: null,
      patternVersion: null,
      acceptedTermsVersionIds: [],
    });
    const problems = collectSubmissionProblems(s);
    expect(problems.map((p) => p.split(':')[0]).sort()).toEqual([
      'color',
      'fabric',
      'patternVersion',
      'product',
      'sampleSize',
      'terms',
    ]);
  });

  it('treats a custom color given only as Pantone or hex as present', () => {
    for (const patch of [
      { customPantone: '18-1664' },
      { customHex: '#ff0000' },
      { customColorName: 'Brick' },
    ]) {
      const s = base();
      Object.assign(s, { fabricColorId: null, fabricColor: null, ...patch });
      expect(collectSubmissionProblems(s)).toEqual([]);
    }
  });

  it('validates the colour against its fabric and availability', () => {
    const s = base();
    s.fabricColor = {
      fabricId: 'other',
      isActive: true,
      isAvailable: true,
      archivedAt: null,
    };
    expect(collectSubmissionProblems(s)).toEqual([
      'color: the selected color does not belong to the selected fabric',
    ]);
    s.fabricColor = {
      fabricId: 'f1',
      isActive: true,
      isAvailable: false,
      archivedAt: null,
    };
    expect(collectSubmissionProblems(s)[0]).toMatch(/no longer available/);
  });

  it('enforces the pattern rules', () => {
    const s = base();
    s.patternVersion = {
      status: 'DRAFT',
      pattern: { archivedAt: null, productTypeId: 'pt1', name: 'P' },
    };
    expect(collectSubmissionProblems(s)[0]).toMatch(/only approved versions/);
    s.patternVersion = {
      status: 'SUPERSEDED',
      pattern: { archivedAt: null, productTypeId: 'pt1', name: 'P' },
    };
    expect(collectSubmissionProblems(s)[0]).toMatch(/newer approved version/);
    s.patternVersion = {
      status: 'APPROVED',
      pattern: { archivedAt: null, productTypeId: 'zzz', name: 'P' },
    };
    expect(collectSubmissionProblems(s)[0]).toMatch(/different product type/);
    s.patternVersion = {
      status: 'APPROVED',
      pattern: { archivedAt: new Date(), productTypeId: 'pt1', name: 'P' },
    };
    expect(collectSubmissionProblems(s)[0]).toMatch(/archived/);
  });

  it('requires a size chart file for CUSTOM_SIZE_CHART', () => {
    const s = base();
    Object.assign(s, {
      fitMethod: 'CUSTOM_SIZE_CHART',
      patternVersionId: null,
      patternVersion: null,
    });
    expect(collectSubmissionProblems(s)[0]).toMatch(/SIZE_CHART/);
    s.attachments = [{ asset: { type: 'SIZE_CHART', archivedAt: new Date() } }];
    expect(collectSubmissionProblems(s)).toHaveLength(1); // archived chart does not count
    s.attachments = [{ asset: { type: 'SIZE_CHART', archivedAt: null } }];
    expect(collectSubmissionProblems(s)).toEqual([]);
  });

  it('does not require anything extra for COPY_CUSTOMER_PIECE or NOT_SURE', () => {
    for (const fitMethod of ['COPY_CUSTOMER_PIECE', 'NOT_SURE'] as const) {
      const s = base();
      Object.assign(s, {
        fitMethod,
        patternVersionId: null,
        patternVersion: null,
      });
      expect(collectSubmissionProblems(s)).toEqual([]);
    }
  });

  it('checks gsm against the fabric range only when both are known', () => {
    const s = base();
    s.gsm = 100;
    expect(collectSubmissionProblems(s)[0]).toMatch(
      /gsm: 100 is outside the French Terry range/,
    );
    s.gsm = null;
    expect(collectSubmissionProblems(s)).toEqual([]);
  });

  it('validates decorations and their artwork', () => {
    const s = base();
    const deco = {
      placement: 'chest',
      colorCount: 2,
      artworkRequired: true,
      artworkId: null,
      printMethod: {
        name: 'Screen Print',
        isActive: true,
        archivedAt: null,
        maxColors: 6,
      },
      artwork: null,
    };
    s.decorations = [{ ...deco }];
    expect(collectSubmissionProblems(s)).toEqual([
      'decorations: decoration #1 (Screen Print): artwork is required',
    ]);

    s.decorations = [
      {
        ...deco,
        artworkId: 'a1',
        artwork: {
          name: 'Logo',
          archivedAt: null,
          brandId: 'b1',
          sampleId: null,
          versions: [{ status: 'REJECTED' }],
        },
      },
    ];
    expect(collectSubmissionProblems(s)[0]).toMatch(/no usable version/);

    s.decorations = [
      {
        ...deco,
        artworkId: 'a1',
        artwork: {
          name: 'Logo',
          archivedAt: null,
          brandId: 'b1',
          sampleId: null,
          versions: [{ status: 'DRAFT' }],
        },
      },
    ];
    expect(collectSubmissionProblems(s)).toEqual([]);

    s.decorations = [{ ...deco, colorCount: 9, artworkRequired: false }];
    expect(collectSubmissionProblems(s)[0]).toMatch(
      /exceeds the method maximum of 6/,
    );

    s.decorations = [
      {
        ...deco,
        artworkRequired: false,
        artworkId: 'a2',
        artwork: {
          name: 'Other',
          archivedAt: null,
          brandId: 'another-brand',
          sampleId: null,
          versions: [],
        },
      },
    ];
    expect(collectSubmissionProblems(s)[0]).toMatch(
      /different brand or sample/,
    );
  });

  it('requires acceptance of the active terms only when terms are active', () => {
    const s = base();
    s.acceptedTermsVersionIds = [];
    expect(collectSubmissionProblems(s)[0]).toMatch(/must be accepted/);
    s.activeTerms = null;
    expect(collectSubmissionProblems(s)).toEqual([]);
    s.activeTerms = { id: 't2', version: 2 };
    s.acceptedTermsVersionIds = ['t1'];
    expect(collectSubmissionProblems(s)[0]).toMatch(/version 2/);
  });

  it('blocks blocked/archived customers and foreign or archived brands', () => {
    const s = base();
    s.customer.status = 'BLOCKED';
    expect(collectSubmissionProblems(s)[0]).toMatch(/blocked/);
    s.customer.status = 'ACTIVE';
    s.brand.customerId = 'other';
    expect(collectSubmissionProblems(s)[0]).toMatch(/does not belong/);
    s.brand.customerId = 'c1';
    s.brand.archivedAt = new Date();
    expect(collectSubmissionProblems(s)[0]).toMatch(/archived/);
  });
});
