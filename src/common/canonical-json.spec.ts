import { canonicalJson, sha256Hex } from './canonical-json.js';

describe('canonicalJson', () => {
  it('is independent of key order, at any depth', () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } };
    const b = { a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256Hex(canonicalJson(a))).toBe(sha256Hex(canonicalJson(b)));
  });

  it('distinguishes different content and keeps array order', () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(sha256Hex(canonicalJson({ a: 1 }))).not.toBe(
      sha256Hex(canonicalJson({ a: 2 })),
    );
  });

  it('serialises dates as ISO strings and drops undefined', () => {
    expect(
      canonicalJson({ d: new Date('2026-01-02T03:04:05Z'), u: undefined }),
    ).toBe('{"d":"2026-01-02T03:04:05.000Z"}');
  });
});
