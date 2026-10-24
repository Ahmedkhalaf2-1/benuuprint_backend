import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import { StaffTasksService } from '../factory/staff-tasks.service.js';
import { ManagementContext } from '../management/management-context.service.js';
import { businessDayKey } from '../management/pure/business-time.js';
import { QrService } from './qr.service.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const esc = (v: string | number | null | undefined) =>
  String(v ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export type JobCard = Awaited<ReturnType<JobCardService['card']>>;

/**
 * The job card: the safe, printable summary of a factory job. It carries what a person at a machine needs
 * (what, how many, how urgent, where it is, which approved specification, the essential instructions) and
 * deliberately nothing commercial or personal: no prices, payments, quotations, customer contact details,
 * not even the customer's name (the brand label only), like every other floor-facing view.
 */
@Injectable()
export class JobCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
    private readonly staffTasks: StaffTasksService,
    private readonly ctx: ManagementContext,
  ) {}

  async card(jobId: string) {
    const job = await this.prisma.factoryJob.findUnique({
      where: { id: jobId },
      include: {
        stages: {
          where: {
            supersededAt: null,
            status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
          },
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            stageCode: true,
            stageName: true,
            status: true,
            dueAt: true,
          },
        },
        productionSpec: {
          select: {
            id: true,
            revision: true,
            kind: true,
            specHash: true,
            snapshot: true,
          },
        },
        orderBatch: { select: { batchNumber: true } },
        order: { select: { orderNumber: true } },
        sample: { select: { sampleNumber: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    const brand = await this.prisma.brand.findUnique({
      where: { id: job.brandId },
      select: { name: true },
    });
    const snap = (job.productionSpec.snapshot ?? {}) as Record<string, any>;
    const pick = (o: Record<string, any> | undefined, keys: string[]) =>
      Object.fromEntries(keys.filter((k) => o?.[k]).map((k) => [k, o![k]]));
    const tz = this.ctx.timezone;
    return {
      jobId: job.id,
      jobNumber: job.jobNumber,
      kind:
        job.sourceType === 'SAMPLE_PRODUCTION'
          ? ('SAMPLE' as const)
          : ('BULK' as const),
      orderNumber: job.order?.orderNumber ?? null,
      sampleNumber:
        job.sample?.sampleNumber ??
        (snap.sample?.sampleNumber as string | undefined) ??
        null,
      batchNumber: job.orderBatch?.batchNumber ?? null,
      brand: brand?.name ?? null,
      product: job.productName,
      quantity: job.plannedQuantity,
      priority: job.priority,
      status: job.status,
      targetDate: job.targetCompletionDate
        ? businessDayKey(job.targetCompletionDate, tz)
        : null,
      currentStages: job.stages.map((s) => ({
        stageCode: s.stageCode,
        stageName: s.stageName,
        status: s.status,
        dueAt: s.dueAt,
      })),
      specification: {
        kind: job.productionSpec.kind,
        revision: job.productionSpec.revision,
        reference: job.productionSpec.specHash.slice(0, 12),
      },
      material: {
        fabric: snap.fabric?.name ?? null,
        color: snap.color?.name ?? null,
        pantone: snap.color?.pantone ?? null,
        gsm: snap.gsm ?? null,
      },
      instructions: pick(snap.instructions, [
        'specialInstructions',
        'factoryInstructions',
      ]),
    };
  }

  /** Deterministic print HTML: escaped values, no scripts, no external resources. The QR is inline SVG. */
  async html(jobId: string): Promise<string> {
    const c = await this.card(jobId);
    const url = await this.qr.activeUrl(jobId);
    const svg = url ? await this.qr.svg(url) : null;
    const line = (k: string, v: string | number | null | undefined) =>
      `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
    const instr = Object.entries(c.instructions as Record<string, string>)
      .map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v)}</p>`)
      .join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(c.jobNumber)} job card</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font:14px/1.4 Arial,Helvetica,sans-serif;margin:24px;color:#000}
  h1{margin:0 0 4px;font-size:26px} .sub{color:#444;margin-bottom:12px}
  table{border-collapse:collapse;width:100%;margin:8px 0} th{text-align:left;width:160px;padding:4px 8px;background:#f3f3f3;border:1px solid #bbb}
  td{padding:4px 8px;border:1px solid #bbb} .qr{float:right;width:180px;text-align:center;font-size:11px}
  .qr svg{width:180px;height:180px} @media print{body{margin:8mm}}
</style></head><body>
${svg ? `<div class="qr">${svg}<div>Scan with the factory app and sign in</div></div>` : ''}
<h1>${esc(c.jobNumber)}</h1>
<div class="sub">${esc(c.kind === 'SAMPLE' ? 'Sample production' : 'Bulk production')} · priority ${esc(c.priority)} · ${esc(c.status)}</div>
<table>
${line('Order / sample', [c.orderNumber, c.sampleNumber].filter(Boolean).join(' / '))}
${c.batchNumber ? line('Batch', c.batchNumber) : ''}
${line('Brand', c.brand)}
${line('Product', c.product)}
${line('Quantity', c.quantity ?? 'n/a (sample)')}
${line('Target date', c.targetDate)}
${line('Current stage', c.currentStages.map((s) => `${s.stageName} (${s.status})`).join(', ') || 'none')}
${line('Approved specification', `${c.specification.kind} r${c.specification.revision} · ${c.specification.reference}`)}
${line('Fabric / colour', [c.material.fabric, c.material.color, c.material.pantone, c.material.gsm ? `${c.material.gsm} gsm` : null].filter(Boolean).join(' · '))}
</table>
${instr ? `<h3>Instructions</h3>${instr}` : ''}
</body></html>`;
  }

  /**
   * A signed-in staff member scanned a QR code. The token only identifies the job; visibility is the usual rule:
   * people assigned to a stage of the job (or holding jobs.read_all) get the card and their own tasks, everybody
   * else gets exactly the answer an unknown code gets.
   */
  async scan(token: string, actor: AuthUser) {
    const jobId = await this.qr.resolve(token);
    if (!jobId) throw new NotFoundException('QR code not recognised');
    const mine = await this.prisma.jobStage.findMany({
      where: {
        jobId,
        supersededAt: null,
        assignments: { some: { userId: actor.id, removedAt: null } },
      },
      orderBy: { sequence: 'asc' },
      select: { id: true, status: true },
    });
    if (mine.length === 0 && !actor.permissions.has('jobs.read_all'))
      throw new NotFoundException('QR code not recognised');
    const open = mine
      .filter((s) => ['READY', 'IN_PROGRESS', 'BLOCKED'].includes(s.status))
      .slice(0, 10);
    const [card, tasks] = await Promise.all([
      this.card(jobId),
      Promise.all(open.map((s) => this.staffTasks.stageDetail(s.id, actor))),
    ]);
    return { card, myTasks: tasks };
  }
}
