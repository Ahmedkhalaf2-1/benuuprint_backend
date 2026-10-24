/**
 * Business-completeness rules checked when a DRAFT is submitted. Pure: the
 * service loads the data, this returns every problem at once so the caller can
 * fix them in one pass. Nothing is auto-corrected.
 */
export interface SubmissionInput {
  customer: { displayName: string; status: string };
  brand: { name: string; customerId: string; archivedAt: Date | null };
  customerId: string;
  brandId: string;
  sampleId: string;

  productTypeId: string | null;
  customProductName: string | null;
  productType: {
    name: string;
    isActive: boolean;
    archivedAt: Date | null;
  } | null;

  fabricId: string | null;
  customFabricName: string | null;
  fabric: {
    name: string;
    isActive: boolean;
    archivedAt: Date | null;
    minGsm: number | null;
    maxGsm: number | null;
  } | null;

  fabricColorId: string | null;
  customColorName: string | null;
  customPantone: string | null;
  customHex: string | null;
  fabricColor: {
    fabricId: string;
    isActive: boolean;
    isAvailable: boolean;
    archivedAt: Date | null;
  } | null;

  gsm: number | null;
  sampleSizeOptionId: string | null;
  sampleSize: { isActive: boolean; archivedAt: Date | null } | null;

  fitMethod:
    'BENUE_PATTERN' | 'COPY_CUSTOMER_PIECE' | 'CUSTOM_SIZE_CHART' | 'NOT_SURE';
  patternVersionId: string | null;
  patternVersion: {
    status: string;
    pattern: { archivedAt: Date | null; productTypeId: string; name: string };
  } | null;

  decorations: {
    placement: string;
    colorCount: number | null;
    artworkRequired: boolean;
    artworkId: string | null;
    printMethod: {
      name: string;
      isActive: boolean;
      archivedAt: Date | null;
      maxColors: number | null;
    };
    artwork: {
      name: string;
      archivedAt: Date | null;
      brandId: string | null;
      sampleId: string | null;
      versions: { status: string }[];
    } | null;
  }[];

  attachments: { asset: { type: string; archivedAt: Date | null } }[];

  acceptedTermsVersionIds: string[];
  activeTerms: { id: string; version: number } | null;
}

export function collectSubmissionProblems(s: SubmissionInput): string[] {
  const problems: string[] = [];
  const add = (field: string, message: string) =>
    problems.push(`${field}: ${message}`);

  // --- parties ---
  if (s.customer.status === 'ARCHIVED' || s.customer.status === 'BLOCKED') {
    add(
      'customer',
      `${s.customer.displayName} is ${s.customer.status.toLowerCase()} and cannot submit samples`,
    );
  }
  if (s.brand.customerId !== s.customerId) {
    add('brand', "does not belong to the sample's customer");
  } else if (s.brand.archivedAt) {
    add('brand', `${s.brand.name} is archived`);
  }

  // --- product ---
  if (s.productTypeId) {
    if (!s.productType || s.productType.archivedAt || !s.productType.isActive) {
      add('product', 'the selected product type is no longer available');
    }
  } else if (!s.customProductName?.trim()) {
    add('product', 'choose a product type or enter a custom product name');
  }

  // --- fabric ---
  if (s.fabricId) {
    if (!s.fabric || s.fabric.archivedAt || !s.fabric.isActive) {
      add('fabric', 'the selected fabric is no longer available');
    }
  } else if (!s.customFabricName?.trim()) {
    add(
      'fabric',
      'choose a fabric (use "Other / Not Sure" if undecided) or enter a custom fabric name',
    );
  }

  // --- colour ---
  const hasCustomColor = !!(
    s.customColorName?.trim() ||
    s.customPantone?.trim() ||
    s.customHex
  );
  if (s.fabricColorId) {
    if (
      !s.fabricColor ||
      s.fabricColor.archivedAt ||
      !s.fabricColor.isActive ||
      !s.fabricColor.isAvailable
    ) {
      add('color', 'the selected fabric color is no longer available');
    } else if (s.fabricColor.fabricId !== s.fabricId) {
      add('color', 'the selected color does not belong to the selected fabric');
    }
  } else if (!hasCustomColor) {
    add(
      'color',
      'choose a fabric color or enter a custom color name, Pantone or hex',
    );
  }

  // --- gsm ---
  if (s.gsm !== null && s.fabric) {
    const { minGsm, maxGsm } = s.fabric;
    if (
      (minGsm !== null && s.gsm < minGsm) ||
      (maxGsm !== null && s.gsm > maxGsm)
    ) {
      add(
        'gsm',
        `${s.gsm} is outside the ${s.fabric.name} range (${minGsm ?? '…'}–${maxGsm ?? '…'})`,
      );
    }
  }

  // --- size ---
  if (!s.sampleSizeOptionId) {
    add('sampleSize', 'a sample size is required');
  } else if (
    !s.sampleSize ||
    s.sampleSize.archivedAt ||
    !s.sampleSize.isActive
  ) {
    add('sampleSize', 'the selected size is no longer available');
  }

  // --- fit ---
  if (s.fitMethod === 'BENUE_PATTERN') {
    if (!s.patternVersionId || !s.patternVersion) {
      add(
        'patternVersion',
        'a Benue pattern version is required for fit method BENUE_PATTERN',
      );
    } else {
      const { status, pattern } = s.patternVersion;
      if (pattern.archivedAt)
        add('patternVersion', `pattern ${pattern.name} is archived`);
      if (status !== 'APPROVED') {
        add(
          'patternVersion',
          status === 'SUPERSEDED'
            ? `pattern ${pattern.name} has a newer approved version; select the current one`
            : `pattern ${pattern.name} version is ${status}; only approved versions can be used`,
        );
      }
      if (s.productTypeId && pattern.productTypeId !== s.productTypeId) {
        add(
          'patternVersion',
          `pattern ${pattern.name} is for a different product type`,
        );
      }
    }
  } else if (s.fitMethod === 'CUSTOM_SIZE_CHART') {
    const charts = s.attachments.filter(
      (a) => a.asset.type === 'SIZE_CHART' && !a.asset.archivedAt,
    );
    if (charts.length === 0) {
      add(
        'fit',
        'attach at least one SIZE_CHART file for fit method CUSTOM_SIZE_CHART',
      );
    }
  }

  // --- decorations ---
  s.decorations.forEach((d, index) => {
    const label = `decoration #${index + 1} (${d.printMethod.name})`;
    if (d.printMethod.archivedAt || !d.printMethod.isActive) {
      add('decorations', `${label}: the print method is no longer available`);
    }
    if (!d.placement.trim())
      add('decorations', `${label}: placement is required`);
    if (
      d.printMethod.maxColors !== null &&
      d.colorCount !== null &&
      d.colorCount > d.printMethod.maxColors
    ) {
      add(
        'decorations',
        `${label}: ${d.colorCount} colors exceeds the method maximum of ${d.printMethod.maxColors}`,
      );
    }
    if (d.artworkRequired) {
      if (!d.artworkId || !d.artwork) {
        add('decorations', `${label}: artwork is required`);
      } else if (d.artwork.archivedAt) {
        add('decorations', `${label}: artwork ${d.artwork.name} is archived`);
      } else if (!d.artwork.versions.some((v) => v.status !== 'REJECTED')) {
        add(
          'decorations',
          `${label}: artwork ${d.artwork.name} has no usable version`,
        );
      }
    }
    if (
      d.artwork &&
      d.artwork.brandId !== s.brandId &&
      d.artwork.sampleId !== s.sampleId
    ) {
      add(
        'decorations',
        `${label}: artwork belongs to a different brand or sample`,
      );
    }
  });

  // --- terms ---
  if (s.activeTerms && !s.acceptedTermsVersionIds.includes(s.activeTerms.id)) {
    add(
      'terms',
      `the active sample terms (version ${s.activeTerms.version}) must be accepted before submitting`,
    );
  }

  return problems;
}
