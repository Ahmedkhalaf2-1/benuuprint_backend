/**
 * Which order revisions change what the customer was quoted for?
 *
 * The single place that decides "commercially relevant". A revision that is commercially relevant
 * ends the validity of every live quotation version of the order (the accepted one included) and the
 * order needs a new quotation + decision before it can be released for production again.
 *
 * COMMERCIAL (re-approval required)
 *  - the approved reference the order produces
 *  - the set of items (a product added, removed or renamed) and each item's quantity
 *  - the total quantity
 *  - the size/colour breakdown: a size or colour added or removed, or any variant quantity changed
 *    (sizes and colours can price differently)
 *
 * NOT COMMERCIAL (the accepted quotation stays valid)
 *  - internal notes, item and variant notes, target delivery date, priority
 *  - shade details of a colour that keep the colour itself (hex / pantone / internal code)
 *  - re-ordering rows without changing what they contain
 *
 * Packaging is a separate, unpriced specification (OrderPackagingSpec) and is not part of an order
 * revision: it never invalidates a quotation. If packaging ever gets priced, add it here.
 */

interface SnapshotVariant {
  size?: { source?: string; code?: string; name?: string } | null;
  color?: { source?: string; name?: string } | null;
  quantity?: number;
}
interface SnapshotItem {
  productName?: string;
  quantity?: number;
  variants?: SnapshotVariant[];
}
export interface RevisionSnapshot {
  totalQuantity?: number;
  reference?: { approvedProductionSpecId?: string };
  items?: SnapshotItem[];
}

export interface RevisionImpact {
  commercial: boolean;
  /** Human-readable, stable reasons; empty when the revision is not commercial. */
  reasons: string[];
}

const sizeKey = (v: SnapshotVariant) =>
  v.size ? `${v.size.source}:${v.size.code ?? ''}:${v.size.name ?? ''}` : '-';
const colorKey = (v: SnapshotVariant) =>
  v.color ? `${v.color.source}:${v.color.name ?? ''}` : '-';

/** `product` -> `size|color` -> quantity (summed: two rows of the same size/colour are one price point). */
function breakdown(snapshot: RevisionSnapshot) {
  const out = new Map<string, Map<string, number>>();
  for (const item of snapshot.items ?? []) {
    const name = item.productName ?? '';
    const variants = out.get(name) ?? new Map<string, number>();
    for (const v of item.variants ?? []) {
      const key = `${sizeKey(v)}|${colorKey(v)}`;
      variants.set(key, (variants.get(key) ?? 0) + (v.quantity ?? 0));
    }
    out.set(name, variants);
  }
  return out;
}

function itemQuantities(snapshot: RevisionSnapshot) {
  const out = new Map<string, number>();
  for (const item of snapshot.items ?? [])
    out.set(
      item.productName ?? '',
      (out.get(item.productName ?? '') ?? 0) + (item.quantity ?? 0),
    );
  return out;
}

export function classifyOrderRevision(
  previous: RevisionSnapshot,
  next: RevisionSnapshot,
): RevisionImpact {
  const reasons: string[] = [];
  if (
    previous.reference?.approvedProductionSpecId !==
    next.reference?.approvedProductionSpecId
  )
    reasons.push('The approved reference changed');
  if (previous.totalQuantity !== next.totalQuantity)
    reasons.push(
      `Total quantity changed from ${previous.totalQuantity} to ${next.totalQuantity}`,
    );

  const before = itemQuantities(previous);
  const after = itemQuantities(next);
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (!before.has(name)) reasons.push(`Item "${name}" was added`);
    else if (!after.has(name)) reasons.push(`Item "${name}" was removed`);
    else if (before.get(name) !== after.get(name))
      reasons.push(
        `Item "${name}" quantity changed from ${before.get(name)} to ${after.get(name)}`,
      );
  }

  const bBefore = breakdown(previous);
  const bAfter = breakdown(next);
  for (const name of new Set([...bBefore.keys(), ...bAfter.keys()])) {
    if (!bBefore.has(name) || !bAfter.has(name)) continue; // reported as added / removed above
    const was = bBefore.get(name)!;
    const now = bAfter.get(name)!;
    for (const key of new Set([...was.keys(), ...now.keys()])) {
      if (was.get(key) !== now.get(key))
        reasons.push(
          `Size/colour breakdown of "${name}" changed (${key.replace('|', ' / ')}: ${was.get(key) ?? 0} → ${now.get(key) ?? 0})`,
        );
    }
  }
  return { commercial: reasons.length > 0, reasons };
}

/** The same comparison for items that are not frozen yet (DRAFT / PENDING_CONFIRMATION edits). */
export interface ItemRowLike {
  productNameSnapshot: string;
  quantity: number;
  variants: {
    sizeOptionId: string | null;
    customSizeName: string | null;
    fabricColorId: string | null;
    customColorName: string | null;
    quantity: number;
  }[];
}

export function snapshotFromRows(
  approvedProductionSpecId: string,
  rows: ItemRowLike[],
): RevisionSnapshot {
  return {
    reference: { approvedProductionSpecId },
    totalQuantity: rows.reduce((n, r) => n + r.quantity, 0),
    items: rows.map((r) => ({
      productName: r.productNameSnapshot,
      quantity: r.quantity,
      variants: r.variants.map((v) => ({
        size: v.sizeOptionId
          ? { source: 'CATALOG', code: v.sizeOptionId }
          : v.customSizeName
            ? { source: 'CUSTOM', name: v.customSizeName }
            : null,
        color: v.fabricColorId
          ? { source: 'CATALOG', name: v.fabricColorId }
          : v.customColorName
            ? { source: 'CUSTOM', name: v.customColorName }
            : null,
        quantity: v.quantity,
      })),
    })),
  };
}
