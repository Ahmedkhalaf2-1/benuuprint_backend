import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../../common/canonical-json.js';
import { AuditAction } from '../../common/enums/audit-actions.js';
import {
  auditActor,
  type ActorRef,
  type AuthUser,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  Prisma,
  SampleProductionSpec,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { ProductionSpecResponseDto } from './dto/sample-spec.dto.js';
import { SampleTransitionsService } from './sample-transitions.service.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;

const assetRef = (a: {
  id: string;
  type: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
}) => ({
  assetId: a.id,
  type: a.type,
  originalName: a.originalName,
  mimeType: a.mimeType,
  sizeBytes: a.sizeBytes,
  checksum: a.checksum,
});

const graphInclude = {
  customer: true,
  brand: true,
  productType: true,
  fabric: true,
  fabricColor: true,
  sampleSize: { include: { scale: true } },
  patternVersion: {
    include: {
      pattern: { include: { productType: true } },
      attachments: { include: { asset: true }, orderBy: { createdAt: 'asc' } },
    },
  },
  decorations: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      printMethod: true,
      artwork: {
        include: {
          versions: { where: { status: 'APPROVED' }, include: { asset: true } },
        },
      },
    },
  },
  accessories: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { accessory: true },
  },
  components: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { componentOption: true },
  },
  attachments: { orderBy: { createdAt: 'asc' }, include: { asset: true } },
  termsAcceptances: {
    include: { termsVersion: true },
    orderBy: { acceptedAt: 'asc' },
  },
} satisfies Prisma.SampleInclude;

export type SpecGraph = Prisma.SampleGetPayload<{
  include: typeof graphInclude;
}>;
type AcceptedQuotation = Prisma.QuotationVersionGetPayload<{
  include: { quotation: true };
}>;

export interface SpecApprovalInfo {
  id: string;
  mode: string | null;
  respondedAt: Date | null;
  respondedByUserId: string | null;
  /** Set for an authenticated customer approval (portal); then respondedByUserId is null. */
  respondedByCustomerId?: string | null;
  sourceNote: string | null;
  responseNote: string | null;
}

/** Problems that make a sample impossible to freeze as a production reference. */
export function findFreezeProblems(
  g: SpecGraph,
  quotation: AcceptedQuotation | null,
): string[] {
  const problems: string[] = [];
  if (!quotation) problems.push('the sample has no accepted quotation');
  if (g.fitMethod === 'BENUE_PATTERN') {
    if (!g.patternVersion)
      problems.push('the Benue pattern version is missing');
    else if (!['APPROVED', 'SUPERSEDED'].includes(g.patternVersion.status)) {
      problems.push('the pattern version is not approved');
    }
  }
  g.decorations.forEach((d, i) => {
    if (
      d.artworkId &&
      d.artwork &&
      d.artwork.versions.length === 0 &&
      d.artworkRequired
    ) {
      problems.push(
        `decoration #${i + 1}: artwork "${d.artwork.name}" has no APPROVED version`,
      );
    }
    if (d.artworkRequired && !d.artworkId)
      problems.push(`decoration #${i + 1}: required artwork is missing`);
  });
  return problems;
}

/**
 * The frozen, self-contained production specification. It stores identifiers
 * AND the values that were true at approval time (names, codes, numbers), plus
 * file checksums, so later edits to master data can never change what was approved.
 */
export function buildProductionSnapshot(
  g: SpecGraph,
  quotation: AcceptedQuotation | null,
  approval: SpecApprovalInfo | null,
  approvedAt: Date,
) {
  const pv = g.patternVersion;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sample: {
      id: g.id,
      sampleNumber: g.sampleNumber,
      revisionNumber: g.revisionNumber,
      revisionOfId: g.revisionOfId,
      submittedAt: g.submittedAt,
      approvedAt,
    },
    customer: {
      id: g.customer.id,
      customerNumber: g.customer.customerNumber,
      displayName: g.customer.displayName,
    },
    brand: {
      id: g.brand.id,
      brandNumber: g.brand.brandNumber,
      name: g.brand.name,
    },
    product: g.productType
      ? {
          source: 'CATALOG',
          productTypeId: g.productType.id,
          code: g.productType.code,
          name: g.productType.name,
          category: g.productType.category,
        }
      : {
          source: 'CUSTOM',
          name: g.customProductName,
          description: g.customProductDescription,
        },
    fabric: g.fabric
      ? {
          source: 'CATALOG',
          fabricId: g.fabric.id,
          referenceNumber: g.fabric.referenceNumber,
          code: g.fabric.code,
          name: g.fabric.name,
          composition: g.fabric.composition,
        }
      : {
          source: 'CUSTOM',
          name: g.customFabricName,
          description: g.customFabricDescription,
        },
    color: g.fabricColor
      ? {
          source: 'CATALOG',
          fabricColorId: g.fabricColor.id,
          name: g.fabricColor.name,
          internalCode: g.fabricColor.internalCode,
          hex: g.fabricColor.hex,
          pantone: g.fabricColor.pantone,
        }
      : {
          source: 'CUSTOM',
          name: g.customColorName,
          pantone: g.customPantone,
          hex: g.customHex,
        },
    fabricProvider: g.fabricProvider,
    gsm: g.gsm,
    size: g.sampleSize
      ? {
          sizeOptionId: g.sampleSize.id,
          code: g.sampleSize.code,
          name: g.sampleSize.name,
          scale: {
            id: g.sampleSize.scale.id,
            code: g.sampleSize.scale.code,
            name: g.sampleSize.scale.name,
          },
        }
      : null,
    fit: {
      method: g.fitMethod,
      patternVersion: pv
        ? {
            patternVersionId: pv.id,
            versionNumber: pv.versionNumber,
            approvedAt: pv.approvedAt,
            patternId: pv.pattern.id,
            referenceNumber: pv.pattern.referenceNumber,
            code: pv.pattern.code,
            name: pv.pattern.name,
            fitType: pv.pattern.fitType,
            productTypeCode: pv.pattern.productType.code,
            files: pv.attachments.map((a) => assetRef(a.asset)),
          }
        : null,
      sizeCharts: g.attachments
        .filter((a) => a.asset.type === 'SIZE_CHART')
        .map((a) => assetRef(a.asset)),
    },
    decorations: g.decorations.map((d) => {
      const approved = d.artwork?.versions[0];
      return {
        printMethod: {
          printMethodId: d.printMethod.id,
          code: d.printMethod.code,
          name: d.printMethod.name,
          type: d.printMethod.type,
        },
        placement: d.placement,
        side: d.side,
        width: d.width?.toFixed(2) ?? null,
        height: d.height?.toFixed(2) ?? null,
        unit: d.unit,
        colorCount: d.colorCount,
        notes: d.notes,
        artworkRequired: d.artworkRequired,
        artwork:
          d.artwork && approved
            ? {
                artworkId: d.artwork.id,
                name: d.artwork.name,
                purpose: d.artwork.purpose,
                artworkVersionId: approved.id,
                versionNumber: approved.versionNumber,
                approvedAt: approved.approvedAt,
                file: assetRef(approved.asset),
              }
            : null,
      };
    }),
    accessories: g.accessories.map((a) => ({
      accessoryId: a.accessory?.id ?? null,
      code: a.accessory?.code ?? null,
      name: a.accessory?.name ?? a.customName,
      custom: !a.accessory,
      quantity: a.quantity,
      notes: a.notes,
    })),
    labelsAndPackaging: g.components.map((c) => ({
      componentOptionId: c.componentOption?.id ?? null,
      code: c.componentOption?.code ?? null,
      category: c.componentOption?.category ?? null,
      name: c.componentOption?.name ?? c.customName,
      custom: !c.componentOption,
      notes: c.notes,
    })),
    attachments: g.attachments.map((a) => assetRef(a.asset)),
    instructions: {
      notes: g.notes,
      fitNotes: g.fitNotes,
      printNotes: g.printNotes,
      fabricNotes: g.fabricNotes,
      specialInstructions: g.specialInstructions,
      factoryInstructions: g.factoryInstructions,
    },
    quotation: quotation
      ? {
          quotationId: quotation.quotationId,
          quotationVersionId: quotation.id,
          quotationNumber: quotation.quotation.quotationNumber,
          versionNumber: quotation.versionNumber,
          currency: quotation.quotation.currency,
          total: quotation.total.toFixed(2),
          acceptedAt: quotation.acceptedAt,
        }
      : null,
    terms: g.termsAcceptances.map((t) => ({
      termsVersionId: t.termsVersion.id,
      code: t.termsVersion.code,
      version: t.termsVersion.version,
      title: t.termsVersion.title,
      mode: t.mode,
      acceptedAt: t.acceptedAt,
    })),
    // null for a PRE_PRODUCTION snapshot: the customer has not approved the physical sample yet
    approval: approval
      ? {
          approvalId: approval.id,
          mode: approval.mode,
          respondedAt: approval.respondedAt,
          recordedByUserId: approval.respondedByUserId,
          ...(approval.respondedByCustomerId && {
            approvedByCustomerId: approval.respondedByCustomerId,
          }),
          sourceNote: approval.sourceNote,
          responseNote: approval.responseNote,
        }
      : null,
  };
}

const toResponse = (s: SampleProductionSpec): ProductionSpecResponseDto => ({
  id: s.id,
  sampleId: s.sampleId,
  revision: s.revision,
  kind: s.kind,
  sourceFactoryJobId: s.sourceFactoryJobId,
  specHash: s.specHash,
  schemaVersion: s.schemaVersion,
  approvalId: s.approvalId,
  snapshot: s.snapshot as Record<string, unknown>,
  createdAt: s.createdAt,
});

@Injectable()
export class SampleProductionSpecService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: SampleTransitionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Called inside the approval transaction when the customer approves a produced
   * sample: validates it can be frozen, writes the immutable snapshot, then moves
   * the sample to APPROVED. All or nothing.
   */
  /** What still stops this sample from being approved (empty = approvable); read-only, no lock. */
  async approvalBlockers(sampleId: string): Promise<string[]> {
    const graph = await this.prisma.sample.findUnique({
      where: { id: sampleId },
      include: graphInclude,
    });
    if (!graph) return ['sample not found'];
    const quotation = await this.prisma.quotationVersion.findFirst({
      where: { status: 'ACCEPTED', quotation: { sampleId } },
      include: { quotation: true },
    });
    return findFreezeProblems(graph, quotation);
  }

  async freezeApprovedSample(
    tx: Prisma.TransactionClient,
    sampleId: string,
    approval: SpecApprovalInfo,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<SampleProductionSpec> {
    await this.transitions.lock(tx, sampleId);
    const graph = await tx.sample.findUnique({
      where: { id: sampleId },
      include: graphInclude,
    });
    if (!graph) throw new NotFoundException('Sample not found');
    if (graph.status !== 'AWAITING_APPROVAL') {
      throw new ConflictException(
        `Cannot approve a sample that is ${graph.status}`,
      );
    }
    const quotation = await tx.quotationVersion.findFirst({
      where: { status: 'ACCEPTED', quotation: { sampleId } },
      include: { quotation: true },
    });
    const problems = findFreezeProblems(graph, quotation);
    if (problems.length) {
      throw new ConflictException(
        `The sample cannot be approved yet: ${problems.join('; ')}`,
      );
    }

    const approvedAt = new Date();
    const snapshot = buildProductionSnapshot(
      graph,
      quotation,
      approval,
      approvedAt,
    );
    const specHash = sha256Hex(canonicalJson(snapshot));
    const latest = await tx.sampleProductionSpec.aggregate({
      where: { sampleId },
      _max: { revision: true },
    });
    // Traceability: the physical sample the customer approved was built by this job.
    const builtBy = await tx.factoryJob.findFirst({
      where: { sampleId, sourceType: 'SAMPLE_PRODUCTION', status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      select: { id: true },
    });
    const spec = await tx.sampleProductionSpec.create({
      data: {
        sampleId,
        kind: 'APPROVED_REFERENCE',
        sourceFactoryJobId: builtBy?.id ?? null,
        revision: (latest._max.revision ?? 0) + 1,
        approvalId: approval.id,
        specHash,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
        customerId: graph.customerId,
        brandId: graph.brandId,
        productTypeId: graph.productTypeId,
        fabricId: graph.fabricId,
        fabricColorId: graph.fabricColorId,
        patternVersionId: graph.patternVersionId,
        sampleSizeOptionId: graph.sampleSizeOptionId,
        quotationVersionId: quotation?.id ?? null,
        termsVersionId: graph.termsAcceptances.at(-1)?.termsVersionId ?? null,
        createdByUserId: actor.customer ? null : actor.id,
      },
    });
    await this.audit.record(
      {
        ...auditActor(actor),
        action: AuditAction.PRODUCTION_SPEC_CREATED,
        entityType: 'Sample',
        entityId: sampleId,
        metadata: {
          sampleNumber: graph.sampleNumber,
          productionSpecId: spec.id,
          revision: spec.revision,
          specHash,
          approvalId: approval.id,
          sourceFactoryJobId: builtBy?.id ?? null,
        },
        meta,
      },
      tx,
    );
    await this.transitions.apply(tx, sampleId, 'sample-approved', {
      actor,
      meta,
      auditMetadata: { approvalId: approval.id, productionSpecId: spec.id },
    });
    return spec;
  }

  /**
   * Freeze what the factory builds the PHYSICAL sample from. Runs inside the job-creation
   * transaction (sample already locked): same content as the final reference, but no customer
   * approval yet. Later master-data edits cannot change it.
   */
  async freezePreProduction(
    tx: Prisma.TransactionClient,
    sampleId: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<SampleProductionSpec> {
    const graph = await tx.sample.findUnique({
      where: { id: sampleId },
      include: graphInclude,
    });
    if (!graph) throw new NotFoundException('Sample not found');
    const quotation = await tx.quotationVersion.findFirst({
      where: { status: 'ACCEPTED', quotation: { sampleId } },
      include: { quotation: true },
    });
    const problems = findFreezeProblems(graph, quotation);
    if (problems.length) {
      throw new ConflictException(
        `The sample cannot be frozen for production: ${problems.join('; ')}`,
      );
    }
    const snapshot = buildProductionSnapshot(
      graph,
      quotation,
      null,
      new Date(),
    );
    const specHash = sha256Hex(canonicalJson(snapshot));
    const latest = await tx.sampleProductionSpec.aggregate({
      where: { sampleId },
      _max: { revision: true },
    });
    const spec = await tx.sampleProductionSpec.create({
      data: {
        sampleId,
        kind: 'PRE_PRODUCTION',
        revision: (latest._max.revision ?? 0) + 1,
        approvalId: null,
        specHash,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
        customerId: graph.customerId,
        brandId: graph.brandId,
        productTypeId: graph.productTypeId,
        fabricId: graph.fabricId,
        fabricColorId: graph.fabricColorId,
        patternVersionId: graph.patternVersionId,
        sampleSizeOptionId: graph.sampleSizeOptionId,
        quotationVersionId: quotation?.id ?? null,
        termsVersionId: graph.termsAcceptances.at(-1)?.termsVersionId ?? null,
        createdByUserId: actor.id,
      },
    });
    await this.audit.record(
      {
        actorUserId: actor.id,
        action: AuditAction.PRODUCTION_SPEC_CREATED,
        entityType: 'Sample',
        entityId: sampleId,
        metadata: {
          sampleNumber: graph.sampleNumber,
          productionSpecId: spec.id,
          kind: 'PRE_PRODUCTION',
          revision: spec.revision,
          specHash,
        },
        meta,
      },
      tx,
    );
    return spec;
  }

  async latest(sampleId: string): Promise<ProductionSpecResponseDto> {
    await this.assertSample(sampleId);
    const spec = await this.prisma.sampleProductionSpec.findFirst({
      where: { sampleId, kind: 'APPROVED_REFERENCE' },
      orderBy: { revision: 'desc' },
    });
    if (!spec)
      throw new NotFoundException(
        'This sample has no approved production reference yet',
      );
    return toResponse(spec);
  }

  async list(sampleId: string): Promise<ProductionSpecResponseDto[]> {
    await this.assertSample(sampleId);
    const specs = await this.prisma.sampleProductionSpec.findMany({
      where: { sampleId },
      orderBy: { revision: 'desc' },
    });
    return specs.map(toResponse);
  }

  private async assertSample(id: string): Promise<void> {
    if (
      !(await this.prisma.sample.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Sample not found');
    }
  }
}
