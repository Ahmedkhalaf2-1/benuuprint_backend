import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { ManagementContext } from './management-context.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { SlaService } from './sla.service.js';
import type { BusinessClock } from './pure/working-time.js';
import {
  evaluateJobDelay,
  evaluateOrderDelay,
  type DelayResult,
  type JobDelayCode,
} from './pure/delay.js';
import {
  evaluateSla,
  resolveDateOrRuleDeadline,
  resolveStageDeadline,
} from './pure/sla.js';

const diffMinutes = (a: Date, b: Date) =>
  Math.round((b.getTime() - a.getTime()) / 60_000);

/** Per-entity SLA and delay evaluation (the explainable view behind the counts and lists). */
@Injectable()
export class DelayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
    private readonly sla: SlaService,
    private readonly calendar: CalendarService,
  ) {}

  /** SLA numbers of one stage occurrence. */
  stageSla(
    s: {
      status: string;
      readyAt: Date | null;
      startedAt: Date | null;
      completedAt: Date | null;
      dueAt: Date | null;
      expectedDurationMinutes: number | null;
      stageDefinitionId: string;
    },
    priority: string,
    rules: Awaited<ReturnType<SlaService['activeRules']>>,
    now: Date,
    clock?: BusinessClock,
  ) {
    const resolved = resolveStageDeadline(
      s,
      rules.stage(s.stageDefinitionId),
      priority,
      clock,
    );
    const completed = s.status === 'COMPLETED' ? s.completedAt : null;
    const ev = evaluateSla({
      startAt: s.readyAt,
      deadline: resolved.deadline,
      completedAt: completed,
      warningBeforeMinutes: resolved.warningBeforeMinutes,
      now,
      clock,
    });
    return {
      state: ev.state,
      deadlineSource: resolved.source,
      deadline: ev.deadline,
      expectedDurationMinutes: resolved.expectedMinutes,
      actualDurationMinutes:
        s.startedAt && s.completedAt
          ? diffMinutes(s.startedAt, s.completedAt)
          : null,
      elapsedMinutes: ev.elapsedMinutes,
      remainingMinutes: ev.remainingMinutes,
      breached: ev.breached,
      breachMinutes: ev.breachMinutes,
      warning: ev.warning,
    };
  }

  async jobDelay(jobId: string) {
    const now = this.ctx.now();
    const job = await this.prisma.factoryJob.findUnique({
      where: { id: jobId },
      include: {
        stages: { orderBy: [{ sequence: 'asc' }, { attempt: 'asc' }] },
        blockers: { where: { status: 'OPEN' } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    const rules = await this.sla.activeRules();
    const clock = await this.calendar.clock();
    const delay = evaluateJobDelay(
      {
        status: job.status,
        targetCompletionDate: job.targetCompletionDate,
        stages: job.stages,
        openBlockers: job.blockers,
      },
      now,
    );
    const jobDeadline = resolveDateOrRuleDeadline(
      job.targetCompletionDate,
      'TARGET_DATE',
      job.createdAt,
      rules.job,
      job.priority,
      now,
      clock,
    );
    return {
      generatedAt: now,
      jobId: job.id,
      jobNumber: job.jobNumber,
      status: job.status,
      priority: job.priority,
      isDelayed: delay.isDelayed,
      delayMinutes: delay.delayMinutes,
      delayReasons: delay.reasons,
      sla: evaluateSla({
        startAt: job.createdAt,
        deadline: jobDeadline.deadline,
        completedAt: job.completedAt,
        warningBeforeMinutes: jobDeadline.warningBeforeMinutes,
        now,
        clock,
      }),
      deadlineSource: jobDeadline.source,
      stages: job.stages
        .filter((s) => !s.supersededAt)
        .map((s) => ({
          stageId: s.id,
          stageCode: s.stageCode,
          stageName: s.stageName,
          status: s.status,
          sla: this.stageSla(s, job.priority, rules, now, clock),
        })),
    };
  }

  /** Delay of many jobs at once (board rows). */
  jobDelayFor(
    job: {
      status: string;
      targetCompletionDate: Date | null;
      stages: Parameters<typeof evaluateJobDelay>[0]['stages'];
      blockers: { id: string; type: string; createdAt: Date; status: string }[];
    },
    now: Date,
  ): DelayResult<JobDelayCode> {
    return evaluateJobDelay(
      {
        status: job.status,
        targetCompletionDate: job.targetCompletionDate,
        stages: job.stages,
        openBlockers: job.blockers.filter((b) => b.status === 'OPEN'),
      },
      now,
    );
  }

  async orderDelay(orderId: string) {
    const now = this.ctx.now();
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        batches: true,
        shipments: {
          select: {
            id: true,
            shipmentNumber: true,
            status: true,
            scheduledAt: true,
            readyAt: true,
          },
        },
        jobs: {
          where: { status: { not: 'CANCELLED' } },
          include: {
            stages: true,
            blockers: { where: { status: 'OPEN' } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const rules = await this.sla.activeRules();
    const clock = await this.calendar.clock();
    const jobs = order.jobs.map((j) => {
      const delay = evaluateJobDelay(
        {
          status: j.status,
          targetCompletionDate: j.targetCompletionDate,
          stages: j.stages,
          openBlockers: j.blockers,
        },
        now,
      );
      return {
        id: j.id,
        jobNumber: j.jobNumber,
        delay,
        delayedPackagingStageIds: j.stages
          .filter(
            (s) =>
              s.departmentType === 'PACKAGING' &&
              delay.reasons.some(
                (r) => r.code === 'STAGE_OVERDUE' && r.refs.includes(s.id),
              ),
          )
          .map((s) => s.id),
      };
    });
    const shipments = order.shipments.map((s) => ({
      id: s.id,
      shipmentNumber: s.shipmentNumber,
      status: s.status,
      deadline: resolveDateOrRuleDeadline(
        s.scheduledAt,
        'SCHEDULED',
        s.readyAt,
        rules.shipment,
        order.priority,
        now,
        clock,
      ).deadline,
    }));
    const delay = evaluateOrderDelay(
      {
        status: order.status,
        targetDeliveryDate: order.targetDeliveryDate,
        jobs,
        batches: order.batches,
        shipments,
      },
      now,
    );
    const deadline = resolveDateOrRuleDeadline(
      order.targetDeliveryDate,
      'TARGET_DATE',
      order.confirmedAt,
      rules.order,
      order.priority,
      now,
      clock,
    );
    const delayDays = delay.delayMinutes
      ? Math.round((delay.delayMinutes / 1440) * 10) / 10
      : 0;
    return {
      generatedAt: now,
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      priority: order.priority,
      targetDeliveryDate: order.targetDeliveryDate,
      isDelayed: delay.isDelayed,
      delayMinutes: delay.delayMinutes,
      delayDays,
      delayReasons: delay.reasons,
      sla: evaluateSla({
        startAt: order.confirmedAt,
        deadline: deadline.deadline,
        completedAt: order.deliveredAt,
        warningBeforeMinutes: deadline.warningBeforeMinutes,
        now,
        clock,
      }),
      deadlineSource: deadline.source,
    };
  }
}
