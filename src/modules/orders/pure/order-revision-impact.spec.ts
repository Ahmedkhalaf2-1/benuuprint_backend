import {
  classifyOrderRevision,
  snapshotFromRows,
  type RevisionSnapshot,
} from './order-revision-impact.js';

const base = (): RevisionSnapshot => ({
  totalQuantity: 100,
  reference: { approvedProductionSpecId: 'ref-1' },
  items: [
    {
      productName: 'Hoodie',
      quantity: 100,
      variants: [
        {
          size: { source: 'CATALOG', code: 'M', name: 'Medium' },
          color: { source: 'CATALOG', name: 'Black' },
          quantity: 60,
        },
        {
          size: { source: 'CATALOG', code: 'L', name: 'Large' },
          color: { source: 'CATALOG', name: 'Black' },
          quantity: 40,
        },
      ],
    },
  ],
});

describe('classifyOrderRevision', () => {
  it('is not commercial when nothing priced changed', () => {
    const next = base();
    expect(classifyOrderRevision(base(), next)).toEqual({
      commercial: false,
      reasons: [],
    });
  });

  it('ignores notes, shade details and the order of rows', () => {
    const next = base();
    (next.items![0] as Record<string, unknown>).notes = 'rush';
    next.items![0]!.variants!.reverse();
    (next.items![0]!.variants![0]!.color as Record<string, unknown>).hex =
      '#000001';
    expect(classifyOrderRevision(base(), next).commercial).toBe(false);
  });

  it('is commercial when the total / item quantity changes', () => {
    const next = base();
    next.totalQuantity = 120;
    next.items![0]!.quantity = 120;
    next.items![0]!.variants![0]!.quantity = 80;
    const r = classifyOrderRevision(base(), next);
    expect(r.commercial).toBe(true);
    expect(r.reasons.join('|')).toMatch(
      /Total quantity changed from 100 to 120/,
    );
  });

  it('is commercial when only the size/colour split moves', () => {
    const next = base();
    next.items![0]!.variants![0]!.quantity = 50;
    next.items![0]!.variants![1]!.quantity = 50;
    const r = classifyOrderRevision(base(), next);
    expect(r.commercial).toBe(true);
    expect(r.reasons).toHaveLength(2);
  });

  it('is commercial when a size, colour or item is added or removed', () => {
    const colour = base();
    colour.items![0]!.variants![1]!.color = { source: 'CATALOG', name: 'Red' };
    expect(classifyOrderRevision(base(), colour).commercial).toBe(true);
    const added = base();
    added.items!.push({ productName: 'Cap', quantity: 0, variants: [] });
    expect(classifyOrderRevision(base(), added).reasons.join()).toMatch(
      /Item "Cap" was added/,
    );
    const ref = base();
    ref.reference!.approvedProductionSpecId = 'ref-2';
    expect(classifyOrderRevision(base(), ref).commercial).toBe(true);
  });

  it('classifies unfrozen item rows the same way', () => {
    const rows = (m: number) => [
      {
        productNameSnapshot: 'Hoodie',
        quantity: m,
        variants: [
          {
            sizeOptionId: 's1',
            customSizeName: null,
            fabricColorId: 'c1',
            customColorName: null,
            quantity: m,
          },
        ],
      },
    ];
    expect(
      classifyOrderRevision(
        snapshotFromRows('r', rows(10)),
        snapshotFromRows('r', rows(10)),
      ).commercial,
    ).toBe(false);
    expect(
      classifyOrderRevision(
        snapshotFromRows('r', rows(10)),
        snapshotFromRows('r', rows(12)),
      ).commercial,
    ).toBe(true);
  });
});
