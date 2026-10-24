import type {
  DepartmentType,
  PrismaClient,
  QcResultType,
} from '../../generated/prisma/client.js';

/**
 * Default factory configuration. Everything is create-if-missing, so re-running never
 * duplicates rows and never overwrites what admins have since changed. Durations are
 * starting points for Benue Print to tune.
 */

interface StageSeed {
  code: string;
  name: string;
  description: string;
  departmentType: DepartmentType;
  sequence: number;
  minutes: number | null;
  requiresAssignment?: boolean;
  requiresCompletionNote?: boolean;
  requiresAttachment?: boolean;
  isQcStage?: boolean;
  eligibleRoleCodes: string[];
}

export const STAGE_DEFINITIONS: StageSeed[] = [
  {
    code: 'FABRIC_PREPARATION',
    name: 'Fabric / Material Preparation',
    description: 'Source, check and prepare the fabric and materials',
    departmentType: 'FABRIC',
    sequence: 1,
    minutes: 480,
    eligibleRoleCodes: ['FABRIC'],
  },
  {
    code: 'PATTERN_MAKING',
    name: 'Pattern Making',
    description: 'Prepare the pattern from the approved fit',
    departmentType: 'PATTERN',
    sequence: 2,
    minutes: 480,
    requiresCompletionNote: true,
    eligibleRoleCodes: ['PATTERN_MAKER'],
  },
  {
    code: 'CUTTING',
    name: 'Cutting',
    description: 'Cut the fabric using the approved pattern',
    departmentType: 'CUTTING',
    sequence: 3,
    minutes: 240,
    eligibleRoleCodes: ['CUTTING'],
  },
  {
    code: 'QC_GATE_1',
    name: 'QC Gate 1 — Cutting / Material Inspection',
    description: 'Inspect fabric, colour, GSM, pattern and cutting',
    departmentType: 'QC',
    sequence: 4,
    minutes: 60,
    isQcStage: true,
    eligibleRoleCodes: ['QC'],
  },
  {
    code: 'PRINTING_EMBROIDERY',
    name: 'Printing / Embroidery',
    description: 'Apply the approved decoration',
    departmentType: 'PRINTING',
    sequence: 5,
    minutes: 480,
    requiresAttachment: true,
    eligibleRoleCodes: ['PRINTING'],
  },
  {
    code: 'QC_GATE_2',
    name: 'QC Gate 2 — Print Inspection',
    description:
      'Inspect artwork, placement, dimensions, colours and print/embroidery quality',
    departmentType: 'QC',
    sequence: 6,
    minutes: 60,
    isQcStage: true,
    eligibleRoleCodes: ['QC'],
  },
  {
    code: 'SEWING',
    name: 'Sewing',
    description: 'Assemble the garment',
    departmentType: 'SEWING',
    sequence: 7,
    minutes: 960,
    eligibleRoleCodes: ['SEWING'],
  },
  {
    code: 'QC_GATE_3',
    name: 'QC Gate 3 — Finished Product Inspection',
    description:
      'Inspect measurements, sewing, finishing, labels, accessories and defects',
    departmentType: 'QC',
    sequence: 8,
    minutes: 60,
    isQcStage: true,
    eligibleRoleCodes: ['QC'],
  },
  {
    code: 'PACKAGING',
    name: 'Packaging',
    description: 'Pack according to the approved labels and packaging',
    departmentType: 'PACKAGING',
    sequence: 9,
    minutes: 120,
    requiresAttachment: true,
    eligibleRoleCodes: ['PACKAGING'],
  },
  {
    code: 'READY',
    name: 'Ready',
    description: 'Finished and ready (delivery comes later)',
    departmentType: 'GENERAL',
    sequence: 10,
    minutes: null,
    requiresAssignment: false,
    eligibleRoleCodes: ['PACKAGING'],
  },
];

interface ItemSeed {
  code: string;
  label: string;
  resultType: QcResultType;
  required?: boolean;
  description?: string;
  config?: Record<string, unknown>;
}

export const QC_TEMPLATES: {
  code: string;
  name: string;
  stage: string;
  items: ItemSeed[];
}[] = [
  {
    code: 'QC1_MATERIAL_CUTTING',
    name: 'QC Gate 1 — material and cutting',
    stage: 'QC_GATE_1',
    items: [
      {
        code: 'FABRIC_CORRECT',
        label: 'Fabric matches the specification',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'COLOR_MATCH',
        label: 'Colour matches the approved colour',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'GSM_MEASURED',
        label: 'Measured GSM',
        resultType: 'NUMBER',
        config: { unit: 'gsm' },
      },
      {
        code: 'PATTERN_MATCH',
        label: 'Pattern matches the approved version',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'CUT_QUALITY',
        label: 'Cutting quality (edges, grain, notches)',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'PIECE_COUNT',
        label: 'Piece count is correct',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'CUTTING_PHOTO',
        label: 'Photo of the cut pieces',
        resultType: 'PHOTO_REQUIRED',
        required: false,
      },
    ],
  },
  {
    code: 'QC2_PRINT',
    name: 'QC Gate 2 — print and embroidery',
    stage: 'QC_GATE_2',
    items: [
      {
        code: 'ARTWORK_MATCH',
        label: 'Artwork matches the approved version',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'PLACEMENT_CORRECT',
        label: 'Placement is correct',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'DIMENSIONS_OK',
        label: 'Dimensions match the specification',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'WIDTH_MEASURED',
        label: 'Measured width',
        resultType: 'MEASUREMENT',
        required: false,
        config: { unit: 'cm', tolerance: 0.5 },
      },
      {
        code: 'COLORS_MATCH',
        label: 'Print colours match',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'PRINT_QUALITY',
        label: 'Print quality (sharpness, cracking, adhesion)',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'EMBROIDERY_QUALITY',
        label: 'Embroidery quality (when applicable)',
        resultType: 'PASS_FAIL',
        required: false,
      },
      {
        code: 'PRINT_PHOTO',
        label: 'Photo proof of the print',
        resultType: 'PHOTO_REQUIRED',
      },
    ],
  },
  {
    code: 'QC3_FINISHED',
    name: 'QC Gate 3 — finished product',
    stage: 'QC_GATE_3',
    items: [
      {
        code: 'MEASUREMENTS_OK',
        label: 'Garment measurements are within tolerance',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'SEWING_QUALITY',
        label: 'Sewing quality (seams, stitches, hems)',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'FINISHING',
        label: 'Finishing (threads, pressing, cleanliness)',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'LABELS_CORRECT',
        label: 'Labels are correct and placed properly',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'ACCESSORIES_CORRECT',
        label: 'Accessories are correct and working',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'DEFECTS_FOUND',
        label: 'Defects found (describe)',
        resultType: 'TEXT',
        required: false,
      },
      {
        code: 'OVERALL_APPEARANCE',
        label: 'Overall appearance',
        resultType: 'PASS_FAIL',
      },
      {
        code: 'FINAL_PHOTO',
        label: 'Photo of the finished product',
        resultType: 'PHOTO_REQUIRED',
      },
    ],
  },
];

export const DEFAULT_WORKFLOW_CODE = 'BENUE_STANDARD_APPAREL';

export async function seedFactory(prisma: PrismaClient): Promise<void> {
  for (const d of STAGE_DEFINITIONS) {
    await prisma.productionStageDefinition.upsert({
      where: { code: d.code },
      create: {
        code: d.code,
        name: d.name,
        description: d.description,
        departmentType: d.departmentType,
        defaultSequence: d.sequence * 10,
        expectedDurationMinutes: d.minutes,
        requiresAssignment: d.requiresAssignment ?? true,
        requiresCompletionNote: d.requiresCompletionNote ?? false,
        requiresAttachment: d.requiresAttachment ?? false,
        isQcStage: d.isQcStage ?? false,
        eligibleRoleCodes: d.eligibleRoleCodes,
      },
      update: {},
    });
  }
  const definitions = new Map(
    (await prisma.productionStageDefinition.findMany()).map((d) => [d.code, d]),
  );

  // Default workflow: created once, as an ACTIVE version-1 sequential chain.
  if (
    !(await prisma.workflowTemplate.findUnique({
      where: { code: DEFAULT_WORKFLOW_CODE },
    }))
  ) {
    const anyDefault = await prisma.workflowTemplate.findFirst({
      where: { isDefault: true },
    });
    const template = await prisma.workflowTemplate.create({
      data: {
        code: DEFAULT_WORKFLOW_CODE,
        name: 'Benue Standard Apparel',
        description:
          'Fabric → pattern → cutting → QC1 → printing/embroidery → QC2 → sewing → QC3 → packaging → ready',
        isDefault: !anyDefault,
      },
    });
    const version = await prisma.workflowTemplateVersion.create({
      data: {
        templateId: template.id,
        version: 1,
        notes: 'Seeded default workflow',
      },
    });
    const created: { id: string }[] = [];
    for (const d of STAGE_DEFINITIONS) {
      const row = await prisma.workflowTemplateStage.create({
        data: {
          versionId: version.id,
          stageDefinitionId: definitions.get(d.code)!.id,
          sequence: d.sequence,
          expectedDurationMinutes: d.minutes,
        },
      });
      if (created.length) {
        await prisma.workflowTemplateStageDependency.create({
          data: {
            stageId: row.id,
            dependsOnStageId: created[created.length - 1]!.id,
          },
        });
      }
      created.push(row);
    }
    await prisma.workflowTemplateVersion.update({
      where: { id: version.id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
  }

  for (const t of QC_TEMPLATES) {
    if (await prisma.qcTemplate.findFirst({ where: { code: t.code } }))
      continue;
    await prisma.qcTemplate.create({
      data: {
        code: t.code,
        name: t.name,
        version: 1,
        stageDefinitionId: definitions.get(t.stage)!.id,
        items: {
          create: t.items.map((item, i) => ({
            code: item.code,
            label: item.label,
            description: item.description,
            resultType: item.resultType,
            required: item.required ?? true,
            sortOrder: (i + 1) * 10,
            config: item.config as object | undefined,
          })),
        },
      },
    });
  }
}
