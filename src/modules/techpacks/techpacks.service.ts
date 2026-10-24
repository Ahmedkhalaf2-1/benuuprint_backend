import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ReferenceService } from '../../database/reference-sequence.js';
import type {
  Prisma,
  TechPack,
  TechPackVersion,
} from '../../generated/prisma/client.js';
import { AssetsService } from '../assets/assets.service.js';
import { AuditService } from '../audit/audit.service.js';
import { QrService } from '../jobcards/qr.service.js';
import {
  buildTechPackContent,
  contentHash,
  redactForFloor,
  type TechPackContent,
} from './pure/tech-pack-content.js';
import { renderTechPackPdf } from './pure/tech-pack-pdf.js';

type Tx = Prisma.TransactionClient;
type Subject = { kind: 'SAMPLE'; id: string } | { kind: 'ORDER'; id: string };

/**
 * Tech packs: versioned, immutable operational documents generated from FROZEN production truth.
 *
 *   SAMPLE → latest PRE_PRODUCTION specification of the sample;
 *   ORDER  → APPROVED_REFERENCE specification + the OrderProductionSpec in force.
 *
 * Lifecycle of a version: DRAFT (generated, reviewable) → ISSUED (the one the floor works from; replaces the
 * previous ISSUED, which becomes SUPERSEDED) → SUPERSEDED. A version's content, hash and source specs never
 * change (database trigger). A changed source (an order revision, a newer pre-production spec) makes the issued
 * version STALE: generate a new version and issue it. Issuing is an operational step; it has nothing to do with
 * the customer approving the sample.
 */
@Injectable()
export class TechPacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
    private readonly assets: AssetsService,
    private readonly qr: QrService,
  ) {}

  // ───────────────────────── generation ─────────────────────────

  async generateForSample(
    sampleId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    return this.generate({ kind: 'SAMPLE', id: sampleId }, actor, meta);
  }

  async generateForOrder(orderId: string, actor: AuthUser, meta: RequestMeta) {
    return this.generate({ kind: 'ORDER', id: orderId }, actor, meta);
  }

  private async generate(subject: Subject, actor: AuthUser, meta: RequestMeta) {
    let assetId: string | null = null;
    try {
      const version = await this.prisma.$transaction(async (tx) => {
        // one generation at a time per sample / order
        if (subject.kind === 'SAMPLE')
          await tx.$queryRaw`SELECT id FROM samples WHERE id = ${subject.id}::uuid FOR UPDATE`;
        else
          await tx.$queryRaw`SELECT id FROM orders WHERE id = ${subject.id}::uuid FOR UPDATE`;
        const src = await this.source(tx, subject);
        const existing = await tx.techPack.findFirst({
          where:
            subject.kind === 'SAMPLE'
              ? { sampleId: subject.id }
              : { orderId: subject.id },
        });
        const pack =
          existing ??
          (await tx.techPack.create({
            data: {
              reference: await this.references.next('TPK', tx),
              sourceType: subject.kind,
              ...(subject.kind === 'SAMPLE'
                ? { sampleId: subject.id }
                : { orderId: subject.id }),
            },
          }));
        const last = await tx.techPackVersion.aggregate({
          where: { techPackId: pack.id },
          _max: { version: true },
        });
        const version = (last._max.version ?? 0) + 1;
        await tx.techPackVersion.updateMany({
          where: { techPackId: pack.id, status: 'DRAFT' },
          data: {
            status: 'SUPERSEDED',
            supersededAt: new Date(),
            supersededReason: `Replaced by a newer draft (v${version})`,
          },
        });
        const generatedAt = new Date();
        const jobCardUrl = src.singleJobId
          ? await this.qr.activeUrl(src.singleJobId, tx)
          : null;
        const content = buildTechPackContent({
          ...src.input,
          reference: pack.reference,
          version,
          generatedAt,
          jobCardUrl,
        });
        const hash = contentHash(content);
        const floorView = redactForFloor(content);
        const pdf = await renderTechPackPdf(floorView, { qrUrl: jobCardUrl });
        const asset = await this.assets.storeGenerated(
          pdf,
          {
            type: 'TECH_PACK',
            originalName: `${pack.reference}-v${version}.pdf`,
            description: `Tech pack ${pack.reference} version ${version}`,
          },
          actor,
          meta,
        );
        assetId = asset.id;
        const row = await tx.techPackVersion.create({
          data: {
            techPackId: pack.id,
            version,
            status: 'DRAFT',
            content: JSON.parse(
              JSON.stringify(content),
            ) as Prisma.InputJsonValue,
            contentHash: hash,
            sampleProductionSpecId: src.specId,
            orderProductionSpecId: src.orderSpecId,
            documentAssetId: asset.id,
            generatedByUserId: actor.id,
            generatedAt,
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.TECH_PACK_GENERATED,
            entityType: 'TechPack',
            entityId: pack.id,
            metadata: {
              reference: pack.reference,
              version,
              versionId: row.id,
              kind: subject.kind,
              contentHash: hash,
              specId: src.specId,
              orderSpecId: src.orderSpecId,
              documentAssetId: asset.id,
            },
            meta,
          },
          tx,
        );
        return row;
      });
      return this.versionView(version.id);
    } catch (e) {
      // the PDF was stored before the row; do not leave an orphan behind
      if (assetId)
        await this.prisma.asset
          .delete({ where: { id: assetId } })
          .catch(() => undefined);
      throw e;
    }
  }

  /** The frozen sources of a pack and everything else the document needs. */
  private async source(tx: Tx, subject: Subject) {
    if (subject.kind === 'SAMPLE') {
      const sample = await tx.sample.findUnique({
        where: { id: subject.id },
        select: { id: true },
      });
      if (!sample) throw new NotFoundException('Sample not found');
      const spec = await tx.sampleProductionSpec.findFirst({
        where: { sampleId: subject.id, kind: 'PRE_PRODUCTION' },
        orderBy: { revision: 'desc' },
      });
      if (!spec)
        throw new ConflictException(
          'The sample has no frozen pre-production specification yet (it is frozen when the sample production job is created)',
        );
      const jobs = await tx.factoryJob.findMany({
        where: { sampleId: subject.id, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, jobNumber: true, status: true },
      });
      return {
        specId: spec.id,
        orderSpecId: null as string | null,
        singleJobId: jobs.length === 1 ? jobs[0]!.id : null,
        input: {
          kind: 'SAMPLE' as const,
          spec: {
            id: spec.id,
            revision: spec.revision,
            kind: spec.kind,
            specHash: spec.specHash,
            snapshot: spec.snapshot as Record<string, unknown>,
          },
          qcRequirements: await this.qcRequirements(tx),
          jobs: jobs.map((j) => ({ jobNumber: j.jobNumber, status: j.status })),
        },
      };
    }
    const order = await tx.order.findUnique({
      where: { id: subject.id },
      include: {
        approvedSpec: true,
        packagingSpec: {
          include: {
            components: {
              orderBy: { sortOrder: 'asc' },
              include: { componentOption: { select: { name: true } } },
            },
          },
        },
        jobs: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            jobNumber: true,
            status: true,
            orderBatch: { select: { batchNumber: true } },
          },
        },
        reorderOf: { select: { orderNumber: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.currentSpecId)
      throw new ConflictException(
        'The order has no frozen production specification yet (confirm it first)',
      );
    if (order.approvedSpec.kind !== 'APPROVED_REFERENCE')
      throw new ConflictException(
        'The order does not reference an approved specification',
      );
    const orderSpec = await tx.orderProductionSpec.findUniqueOrThrow({
      where: { id: order.currentSpecId },
    });
    const pk = order.packagingSpec;
    return {
      specId: order.approvedSpec.id,
      orderSpecId: orderSpec.id as string | null,
      singleJobId: order.jobs.length === 1 ? order.jobs[0]!.id : null,
      input: {
        kind: 'ORDER' as const,
        spec: {
          id: order.approvedSpec.id,
          revision: order.approvedSpec.revision,
          kind: order.approvedSpec.kind,
          specHash: order.approvedSpec.specHash,
          snapshot: order.approvedSpec.snapshot as Record<string, unknown>,
        },
        order: {
          orderNumber: order.orderNumber,
          priority: order.priority,
          targetDeliveryDate: order.targetDeliveryDate,
          reorderOfOrderNumber: order.reorderOf?.orderNumber ?? null,
          spec: {
            id: orderSpec.id,
            revision: orderSpec.revision,
            specHash: orderSpec.specHash,
            totalQuantity: orderSpec.totalQuantity,
            snapshot: orderSpec.snapshot as Record<string, unknown>,
          },
        },
        packaging: pk
          ? {
              foldingInstructions: pk.foldingInstructions,
              polybagRequired: pk.polybagRequired,
              labelsRequired: pk.labelsRequired,
              hangTagsRequired: pk.hangTagsRequired,
              stickersRequired: pk.stickersRequired,
              stickerNotes: pk.stickerNotes,
              unitsPerCarton: pk.unitsPerCarton,
              cartonNotes: pk.cartonNotes,
              specialInstructions: pk.specialInstructions,
              components: pk.components.map((c) => ({
                name: c.customName ?? c.componentOption?.name ?? 'Component',
                quantityPerUnit: c.quantityPerUnit,
                notes: c.notes,
              })),
            }
          : null,
        qcRequirements: await this.qcRequirements(tx),
        jobs: order.jobs.map((j) => ({
          jobNumber: j.jobNumber,
          status: j.status,
          batchNumber: j.orderBatch?.batchNumber ?? null,
        })),
      },
    };
  }

  private async qcRequirements(tx: Tx) {
    const templates = await tx.qcTemplate.findMany({
      where: { isActive: true },
      include: {
        stageDefinition: {
          select: { code: true, name: true, defaultSequence: true },
        },
        items: { orderBy: { sortOrder: 'asc' } },
      },
    });
    return templates
      .sort(
        (a, b) =>
          a.stageDefinition.defaultSequence -
            b.stageDefinition.defaultSequence || a.code.localeCompare(b.code),
      )
      .map((t) => ({
        stageCode: t.stageDefinition.code,
        stageName: t.stageDefinition.name,
        templateCode: t.code,
        templateName: t.name,
        version: t.version,
        items: t.items.map((i) => ({
          code: i.code,
          label: i.label,
          resultType: i.resultType,
          required: i.required,
        })),
      }));
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async issue(versionId: string, actor: AuthUser, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const v = await this.lockedVersion(tx, versionId);
      if (v.status !== 'DRAFT')
        throw new ConflictException(
          `Only a DRAFT can be issued (this version is ${v.status})`,
        );
      if (!v.documentAssetId)
        throw new ConflictException(
          'The version has no document; generate it again',
        );
      if (await this.isStale(tx, v))
        throw new ConflictException(
          'The production specification changed since this version was generated; generate a new version',
        );
      const now = new Date();
      const current = await tx.techPackVersion.findFirst({
        where: { techPackId: v.techPackId, status: 'ISSUED' },
      });
      if (current) {
        await tx.techPackVersion.update({
          where: { id: current.id },
          data: {
            status: 'SUPERSEDED',
            supersededAt: now,
            supersededReason: `Replaced by version ${v.version}`,
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.TECH_PACK_SUPERSEDED,
            entityType: 'TechPack',
            entityId: v.techPackId,
            metadata: {
              versionId: current.id,
              version: current.version,
              replacedBy: v.version,
            },
            meta,
          },
          tx,
        );
      }
      await tx.techPackVersion.update({
        where: { id: versionId },
        data: { status: 'ISSUED', issuedAt: now, issuedByUserId: actor.id },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.TECH_PACK_ISSUED,
          entityType: 'TechPack',
          entityId: v.techPackId,
          metadata: {
            versionId,
            version: v.version,
            contentHash: v.contentHash,
          },
          meta,
        },
        tx,
      );
    });
    return this.versionView(versionId);
  }

  /** Withdraw an ISSUED version or discard a DRAFT. */
  async supersede(
    versionId: string,
    reason: string,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const v = await this.lockedVersion(tx, versionId);
      if (v.status === 'SUPERSEDED')
        throw new ConflictException('The version is already superseded');
      await tx.techPackVersion.update({
        where: { id: versionId },
        data: {
          status: 'SUPERSEDED',
          supersededAt: new Date(),
          supersededReason: reason,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.TECH_PACK_SUPERSEDED,
          entityType: 'TechPack',
          entityId: v.techPackId,
          metadata: { versionId, version: v.version, was: v.status, reason },
          meta,
        },
        tx,
      );
    });
    return this.versionView(versionId);
  }

  private async lockedVersion(
    tx: Tx,
    versionId: string,
  ): Promise<TechPackVersion> {
    const found = await tx.techPackVersion.findUnique({
      where: { id: versionId },
      select: { techPackId: true },
    });
    if (!found) throw new NotFoundException('Tech pack version not found');
    await tx.$queryRaw`SELECT id FROM tech_packs WHERE id = ${found.techPackId}::uuid FOR UPDATE`;
    return tx.techPackVersion.findUniqueOrThrow({ where: { id: versionId } });
  }

  /** The sources moved on after this version was generated. */
  private async isStale(
    client: Tx | PrismaService,
    v: TechPackVersion,
  ): Promise<boolean> {
    const pack = await client.techPack.findUniqueOrThrow({
      where: { id: v.techPackId },
    });
    if (pack.orderId) {
      const o = await client.order.findUnique({
        where: { id: pack.orderId },
        select: { currentSpecId: true, approvedProductionSpecId: true },
      });
      return (
        !o ||
        o.currentSpecId !== v.orderProductionSpecId ||
        o.approvedProductionSpecId !== v.sampleProductionSpecId
      );
    }
    const latest = await client.sampleProductionSpec.findFirst({
      where: { sampleId: pack.sampleId!, kind: 'PRE_PRODUCTION' },
      orderBy: { revision: 'desc' },
      select: { id: true },
    });
    return !latest || latest.id !== v.sampleProductionSpecId;
  }

  // ───────────────────────── reads ─────────────────────────

  private async summary(v: TechPackVersion, stale?: boolean) {
    return {
      id: v.id,
      techPackId: v.techPackId,
      version: v.version,
      status: v.status,
      contentHash: v.contentHash,
      sampleProductionSpecId: v.sampleProductionSpecId,
      orderProductionSpecId: v.orderProductionSpecId,
      hasDocument: !!v.documentAssetId,
      generatedByUserId: v.generatedByUserId,
      generatedAt: v.generatedAt,
      issuedByUserId: v.issuedByUserId,
      issuedAt: v.issuedAt,
      supersededAt: v.supersededAt,
      supersededReason: v.supersededReason,
      stale:
        stale ??
        (v.status === 'SUPERSEDED' ? null : await this.isStale(this.prisma, v)),
    };
  }

  async versionView(id: string) {
    const v = await this.prisma.techPackVersion.findUnique({
      where: { id },
      include: { techPack: true },
    });
    if (!v) throw new NotFoundException('Tech pack version not found');
    return {
      ...(await this.summary(v)),
      reference: v.techPack.reference,
      kind: v.techPack.sourceType,
      content: v.content as unknown as TechPackContent,
    };
  }

  async forSample(sampleId: string) {
    return this.pack({ sampleId });
  }

  async forOrder(orderId: string) {
    return this.pack({ orderId });
  }

  private async pack(where: { sampleId: string } | { orderId: string }) {
    const pack = await this.prisma.techPack.findFirst({
      where,
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!pack) {
      const exists =
        'sampleId' in where
          ? await this.prisma.sample.findUnique({
              where: { id: where.sampleId },
              select: { id: true },
            })
          : await this.prisma.order.findUnique({
              where: { id: where.orderId },
              select: { id: true },
            });
      if (!exists) throw new NotFoundException('Not found');
      return {
        exists: false as const,
        techPack: null,
        versions: [] as Awaited<ReturnType<TechPacksService['summary']>>[],
      };
    }
    return {
      exists: true as const,
      techPack: this.packView(pack),
      versions: await Promise.all(pack.versions.map((v) => this.summary(v))),
    };
  }

  private packView(p: TechPack) {
    return {
      id: p.id,
      reference: p.reference,
      kind: p.sourceType,
      sampleId: p.sampleId,
      orderId: p.orderId,
      createdAt: p.createdAt,
    };
  }

  async documentUrl(versionId: string) {
    const v = await this.prisma.techPackVersion.findUnique({
      where: { id: versionId },
      select: { documentAssetId: true },
    });
    if (!v?.documentAssetId)
      throw new NotFoundException('The version has no document');
    return this.assets.downloadUrl(v.documentAssetId);
  }

  // ───────────────────────── floor ─────────────────────────

  /** The ISSUED pack of the job's sample / order, for people assigned to the job (or with jobs.read_all). */
  private async issuedForJob(jobId: string, actor: AuthUser) {
    const job = await this.prisma.factoryJob.findUnique({
      where: { id: jobId },
      select: { id: true, sampleId: true, orderId: true },
    });
    const assigned = job
      ? (await this.prisma.stageAssignment.count({
          where: { userId: actor.id, removedAt: null, jobStage: { jobId } },
        })) > 0
      : false;
    if (!job || (!assigned && !actor.permissions.has('jobs.read_all')))
      throw new NotFoundException('Job not found');
    const where = job.orderId
      ? { orderId: job.orderId }
      : { sampleId: job.sampleId! };
    const pack = await this.prisma.techPack.findFirst({
      where,
      include: { versions: { where: { status: 'ISSUED' }, take: 1 } },
    });
    const v = pack?.versions[0];
    if (!pack || !v)
      throw new NotFoundException(
        'No tech pack has been issued for this job yet',
      );
    return { pack, v };
  }

  async floorView(jobId: string, actor: AuthUser) {
    const { pack, v } = await this.issuedForJob(jobId, actor);
    return {
      reference: pack.reference,
      version: v.version,
      issuedAt: v.issuedAt,
      stale: await this.isStale(this.prisma, v),
      content: redactForFloor(v.content as unknown as TechPackContent),
    };
  }

  async floorDocumentUrl(jobId: string, actor: AuthUser) {
    const { v } = await this.issuedForJob(jobId, actor);
    return this.documentUrl(v.id);
  }

  assertReason(reason: string | undefined): string {
    if (!reason || reason.trim().length < 3)
      throw new BadRequestException('A reason is required');
    return reason.trim();
  }
}
