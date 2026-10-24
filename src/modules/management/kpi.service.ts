import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { D, fmt } from '../commercial/money.js';
import { ManagementContext } from './management-context.service.js';
import {
  delayedJobWhere,
  delayedOrderWhere,
  reapprovalOrderWhere,
  ORDER_NOT_LIVE,
} from './queries.js';
import { ORDER_DELAYABLE_STATUSES } from './pure/delay.js';
import { num } from './sql.js';

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
const roundMin = (v: unknown): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v));

/**
 * KPI definitions (all computed on read, bounded by the requested range; `now` is the management clock):
 *  - "completed in range" uses the completion timestamp, not the creation date;
 *  - rates are null (not 0) when there is nothing to divide by;
 *  - snapshot counts (active, blocked, delayed …) describe the moment of the request.
 */
@Injectable()
export class KpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
  ) {}

  // ───────────────────────── production ─────────────────────────

  async production(q: { from?: string; to?: string }) {
    const now = this.ctx.now();
    const range = this.ctx.range(q);
    const todayStart = this.ctx.todayStart(now);
    const weekStart = this.ctx.weekStart(now);
    const countStatus = (status: string[]) =>
      this.prisma.factoryJob.count({
        where: { status: { in: status as never[] } },
      });
    const inRange = { gte: range.from, lt: range.to };
    const [
      active,
      planned,
      onHold,
      blocked,
      delayed,
      completedInRange,
      completedToday,
      completedWeek,
      lead,
      stageAvg,
      onTime,
    ] = await Promise.all([
      countStatus(['READY', 'IN_PROGRESS', 'BLOCKED']),
      countStatus(['PLANNED']),
      countStatus(['ON_HOLD']),
      countStatus(['BLOCKED']),
      this.prisma.factoryJob.count({ where: delayedJobWhere(now) }),
      this.prisma.factoryJob.count({
        where: { status: 'COMPLETED', completedAt: inRange },
      }),
      this.prisma.factoryJob.count({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: todayStart, lte: now },
        },
      }),
      this.prisma.factoryJob.count({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: weekStart, lte: now },
        },
      }),
      this.prisma.$queryRaw<{ avg: Prisma.Decimal | null }[]>(Prisma.sql`
        SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60.0) AS avg
        FROM factory_jobs
        WHERE status = 'COMPLETED' AND completed_at >= ${range.from} AND completed_at < ${range.to}`),
      this.prisma.$queryRaw<
        { avg: Prisma.Decimal | null; n: number }[]
      >(Prisma.sql`
        SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0) AS avg, COUNT(*)::int AS n
        FROM job_stages
        WHERE status = 'COMPLETED' AND started_at IS NOT NULL
          AND completed_at >= ${range.from} AND completed_at < ${range.to}`),
      this.prisma.$queryRaw<{ on_time: number; total: number }[]>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE completed_at <= target_completion_date)::int AS on_time,
               COUNT(*)::int AS total
        FROM factory_jobs
        WHERE status = 'COMPLETED' AND target_completion_date IS NOT NULL
          AND completed_at >= ${range.from} AND completed_at < ${range.to}`),
    ]);
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      range,
      activeJobs: active,
      plannedJobs: planned,
      onHoldJobs: onHold,
      blockedJobs: blocked,
      delayedJobs: delayed,
      completedJobs: completedInRange,
      completedToday,
      completedThisWeek: completedWeek,
      averageLeadTimeMinutes: roundMin(lead[0]?.avg),
      averageStageDurationMinutes: roundMin(stageAvg[0]?.avg),
      stagesMeasured: num(stageAvg[0]?.n),
      onTimeCompletion: {
        onTime: num(onTime[0]?.on_time),
        measured: num(onTime[0]?.total),
        ratePercent: pct(num(onTime[0]?.on_time), num(onTime[0]?.total)),
      },
      definitions: {
        activeJobs: 'READY, IN_PROGRESS or BLOCKED right now',
        delayedJobs:
          'open jobs with a delay reason (overdue stage, open blocker, target date passed)',
        averageLeadTimeMinutes:
          'createdAt → completedAt of jobs completed in the range',
        averageStageDurationMinutes:
          'startedAt → completedAt of stages completed in the range',
        onTimeCompletion:
          'jobs completed in the range that have a target date: completedAt ≤ target',
      },
    };
  }

  // ───────────────────────── orders ─────────────────────────

  async orders(q: { from?: string; to?: string }) {
    const now = this.ctx.now();
    const range = this.ctx.range(q);
    const inRange = { gte: range.from, lt: range.to };
    const [byStatus, delayed, delivered, closed, cancelled, cycle, onTime] =
      await Promise.all([
        this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.order.count({ where: delayedOrderWhere(now) }),
        this.prisma.order.count({ where: { deliveredAt: inRange } }),
        this.prisma.order.count({ where: { closedAt: inRange } }),
        this.prisma.order.count({ where: { cancelledAt: inRange } }),
        this.prisma.$queryRaw<{ avg: Prisma.Decimal | null }[]>(Prisma.sql`
        SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - confirmed_at)) / 60.0) AS avg
        FROM orders
        WHERE delivered_at >= ${range.from} AND delivered_at < ${range.to} AND confirmed_at IS NOT NULL`),
        this.prisma.$queryRaw<{ on_time: number; total: number }[]>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE delivered_at <= target_delivery_date)::int AS on_time,
               COUNT(*)::int AS total
        FROM orders
        WHERE delivered_at >= ${range.from} AND delivered_at < ${range.to} AND target_delivery_date IS NOT NULL`),
      ]);
    const c = (...s: string[]) =>
      byStatus
        .filter((x) => s.includes(x.status))
        .reduce((n, x) => n + x._count._all, 0);
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      range,
      current: {
        inProduction: c('IN_PRODUCTION', 'PARTIALLY_COMPLETED'),
        productionCompleted: c('PRODUCTION_COMPLETED'),
        readyForDelivery: c(
          'READY_FOR_PACKAGING',
          'PACKAGING',
          'READY_FOR_DELIVERY',
        ),
        partiallyShipped: c('PARTIALLY_SHIPPED'),
        outForDelivery: c('OUT_FOR_DELIVERY'),
        delivered: c('DELIVERED'),
        completed: c('COMPLETED'),
        cancelled: c('CANCELLED'),
        onHold: c('ON_HOLD'),
        delayed,
      },
      inRange: { delivered, completed: closed, cancelled },
      averageCycleTimeMinutes: roundMin(cycle[0]?.avg),
      onTimeDelivery: {
        onTime: num(onTime[0]?.on_time),
        measured: num(onTime[0]?.total),
        ratePercent: pct(num(onTime[0]?.on_time), num(onTime[0]?.total)),
      },
      definitions: {
        readyForDelivery:
          'READY_FOR_PACKAGING, PACKAGING or READY_FOR_DELIVERY (production done, goods not yet out)',
        delayedOrders:
          'live orders with a delay reason (delivery date passed, delayed job or batch, failed / overdue shipment)',
        averageCycleTimeMinutes:
          'confirmedAt → deliveredAt of orders delivered in the range',
        onTimeDelivery:
          'orders delivered in the range with a target date: deliveredAt ≤ targetDeliveryDate',
      },
    };
  }

  // ───────────────────────── quality ─────────────────────────

  async quality(q: { from?: string; to?: string }) {
    const now = this.ctx.now();
    const range = this.ctx.range(q);
    const inRange = { gte: range.from, lt: range.to };
    const [
      results,
      inspecting,
      reworks,
      openRework,
      rejected,
      qcUnits,
      byStage,
      byProduct,
      repeat,
    ] = await Promise.all([
      this.prisma.qcInspection.groupBy({
        by: ['overallResult'],
        where: { status: 'COMPLETED', completedAt: inRange },
        _count: { _all: true },
      }),
      this.prisma.qcInspection.count({ where: { status: 'IN_PROGRESS' } }),
      this.prisma.reworkRecord.aggregate({
        where: { createdAt: inRange, status: { not: 'CANCELLED' } },
        _count: { _all: true },
        _sum: { affectedQuantity: true },
      }),
      this.prisma.reworkRecord.count({
        where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
      }),
      this.prisma.stageProductionReport.aggregate({
        where: { createdAt: inRange },
        _sum: { rejectedQuantity: true, reworkQuantity: true },
      }),
      this.prisma.qcInspection.aggregate({
        where: { status: 'COMPLETED', completedAt: inRange },
        _sum: { inspectedQuantity: true, failedQuantity: true },
      }),
      this.prisma.$queryRaw<
        { code: string; name: string; failures: number; failed_units: number }[]
      >(Prisma.sql`
          SELECT js.stage_code AS code, MAX(js.stage_name) AS name, COUNT(*)::int AS failures,
                 COALESCE(SUM(qi.failed_quantity), 0)::int AS failed_units
          FROM qc_inspections qi JOIN job_stages js ON js.id = qi.job_stage_id
          WHERE qi.status = 'COMPLETED' AND qi.overall_result = 'FAIL'
            AND qi.completed_at >= ${range.from} AND qi.completed_at < ${range.to}
          GROUP BY js.stage_code ORDER BY failures DESC, code`),
      this.prisma.$queryRaw<
        { product_type_id: string | null; product: string; failures: number }[]
      >(Prisma.sql`
          SELECT fj.product_type_id::text AS product_type_id, fj.product_name AS product, COUNT(*)::int AS failures
          FROM qc_inspections qi JOIN factory_jobs fj ON fj.id = qi.job_id
          WHERE qi.status = 'COMPLETED' AND qi.overall_result = 'FAIL'
            AND qi.completed_at >= ${range.from} AND qi.completed_at < ${range.to}
          GROUP BY fj.product_type_id, fj.product_name ORDER BY failures DESC, product`),
      this.prisma.$queryRaw<{ failing: number; repeated: number }[]>(Prisma.sql`
          SELECT COUNT(*)::int AS failing, COUNT(*) FILTER (WHERE n >= 2)::int AS repeated
          FROM (SELECT qi.job_id, js.stage_definition_id, COUNT(*) AS n
                FROM qc_inspections qi JOIN job_stages js ON js.id = qi.job_stage_id
                WHERE qi.status = 'COMPLETED' AND qi.overall_result = 'FAIL'
                  AND qi.completed_at >= ${range.from} AND qi.completed_at < ${range.to}
                GROUP BY qi.job_id, js.stage_definition_id) t`),
    ]);
    const r = (v: string | null) =>
      results.find((x) => x.overallResult === v)?._count._all ?? 0;
    const pass = r('PASS');
    const fail = r('FAIL');
    const cond = r('CONDITIONAL_PASS');
    const total = pass + fail + cond;
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      range,
      inspections: {
        completed: total,
        inProgress: inspecting,
        pass,
        fail,
        conditionalPass: cond,
        passRatePercent: pct(pass, total),
        failRatePercent: pct(fail, total),
        conditionalPassRatePercent: pct(cond, total),
        inspectedUnits: qcUnits._sum.inspectedQuantity ?? 0,
        failedUnits: qcUnits._sum.failedQuantity ?? 0,
      },
      rework: {
        created: reworks._count._all,
        open: openRework,
        affectedQuantity: reworks._sum.affectedQuantity ?? 0,
        note: 'Rework without a recorded affected quantity adds 0 to affectedQuantity',
      },
      rejectedUnits: rejected._sum.rejectedQuantity ?? 0,
      reworkFlaggedUnits: rejected._sum.reworkQuantity ?? 0,
      failuresByStage: byStage.map((x) => ({
        stageCode: x.code,
        stageName: x.name,
        failures: num(x.failures),
        failedUnits: num(x.failed_units),
      })),
      failuresByProduct: byProduct.map((x) => ({
        productTypeId: x.product_type_id,
        productName: x.product,
        failures: num(x.failures),
      })),
      repeatFailure: {
        jobStagesWithFailure: num(repeat[0]?.failing),
        repeated: num(repeat[0]?.repeated),
        ratePercent: pct(num(repeat[0]?.repeated), num(repeat[0]?.failing)),
        definition:
          'share of (job, QC stage) pairs that failed QC more than once in the range',
      },
      notDerived: [
        'Failures by fabric: the fabric is not stored on the job, so it is not reported',
      ],
    };
  }

  // ───────────────────────── commercial ─────────────────────────

  async commercial(q: { from?: string; to?: string }) {
    const now = this.ctx.now();
    const range = this.ctx.range(q);
    const live = Prisma.join(
      ORDER_NOT_LIVE.map((s) => Prisma.sql`${s}::"OrderStatus"`),
    );
    const [balances, verified, states, withoutQuote, reapproval] =
      await Promise.all([
        this.prisma.$queryRaw<
          {
            currency: string;
            orders: number;
            accepted: Prisma.Decimal;
            verified: Prisma.Decimal;
            outstanding: Prisma.Decimal;
            overpaid: Prisma.Decimal;
          }[]
        >(Prisma.sql`
        WITH acc AS (
          SELECT q.order_id, q.currency, qv.total
          FROM quotation_versions qv
          JOIN quotations q ON q.id = qv.quotation_id
          JOIN orders o ON o.id = q.order_id
          WHERE qv.status = 'ACCEPTED' AND o.status NOT IN (${live})
        ), paid AS (
          SELECT p.order_id, p.currency, SUM(p.amount) AS amt
          FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.status = 'VERIFIED' AND o.status NOT IN (${live})
          GROUP BY p.order_id, p.currency
        )
        SELECT acc.currency, COUNT(*)::int AS orders,
               SUM(acc.total) AS accepted,
               SUM(COALESCE(paid.amt, 0)) AS verified,
               SUM(GREATEST(acc.total - COALESCE(paid.amt, 0), 0)) AS outstanding,
               SUM(GREATEST(COALESCE(paid.amt, 0) - acc.total, 0)) AS overpaid
        FROM acc LEFT JOIN paid ON paid.order_id = acc.order_id AND paid.currency = acc.currency
        GROUP BY acc.currency ORDER BY acc.currency`),
        this.prisma.$queryRaw<
          {
            currency: string;
            target: string;
            total: Prisma.Decimal;
            payments: number;
          }[]
        >(Prisma.sql`
        SELECT p.currency, CASE WHEN p.order_id IS NOT NULL THEN 'ORDER' ELSE 'SAMPLE' END AS target,
               SUM(p.amount) AS total, COUNT(*)::int AS payments
        FROM payments p
        WHERE p.status = 'VERIFIED' AND p.verified_at >= ${range.from} AND p.verified_at < ${range.to}
        GROUP BY p.currency, 2 ORDER BY p.currency, 2`),
        this.prisma.order.groupBy({
          by: ['paymentState'],
          where: {
            status: { notIn: [...ORDER_NOT_LIVE] },
            quotations: {
              some: { versions: { some: { status: 'ACCEPTED' } } },
            },
          },
          _count: { _all: true },
        }),
        this.prisma.order.count({
          where: {
            status: { notIn: [...ORDER_NOT_LIVE] },
            NOT: {
              quotations: {
                some: { versions: { some: { status: 'ACCEPTED' } } },
              },
            },
          },
        }),
        this.prisma.order.count({ where: reapprovalOrderWhere }),
      ]);
    const s = (v: string) =>
      states.find((x) => x.paymentState === v)?._count._all ?? 0;
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      range,
      /** Money is never summed across currencies. */
      byCurrency: balances.map((b) => ({
        currency: b.currency,
        ordersWithAcceptedQuotation: num(b.orders),
        acceptedQuotationValue: fmt(D(b.accepted)),
        verifiedPayments: fmt(D(b.verified)),
        outstandingBalance: fmt(D(b.outstanding)),
        overpaidAmount: fmt(D(b.overpaid)),
      })),
      verifiedInRange: verified.map((v) => ({
        currency: v.currency,
        target: v.target,
        total: fmt(D(v.total)),
        payments: num(v.payments),
      })),
      orders: {
        unpaid: s('UNPAID'),
        partiallyPaid: s('PARTIALLY_PAID'),
        paid: s('PAID'),
        withoutAcceptedQuotation: withoutQuote,
        commercialReapprovalRequired: reapproval,
      },
      definitions: {
        scope: 'orders that are not cancelled, draft or pending confirmation',
        outstandingBalance:
          'accepted quotation total − verified payments, per order, never below 0',
        overpaidAmount:
          'verified payments above the accepted total (e.g. after a smaller re-quote); not refunded automatically',
        verifiedInRange:
          'payments verified within the range, orders and samples',
      },
    };
  }

  // ───────────────────────── delivery ─────────────────────────

  async delivery(q: { from?: string; to?: string }) {
    const now = this.ctx.now();
    const range = this.ctx.range(q);
    const inRange = { gte: range.from, lt: range.to };
    const [
      open,
      delivered,
      returned,
      dispatchToDelivery,
      partial,
      overdueOrders,
      overdueShipments,
    ] = await Promise.all([
      this.prisma.shipment.groupBy({
        by: ['status'],
        where: {
          status: {
            in: ['DRAFT', 'READY', 'DISPATCHED', 'IN_TRANSIT', 'FAILED'],
          },
        },
        _count: { _all: true },
      }),
      this.prisma.shipment.count({ where: { deliveredAt: inRange } }),
      this.prisma.shipment.count({ where: { returnedAt: inRange } }),
      this.prisma.$queryRaw<
        { avg: Prisma.Decimal | null; n: number }[]
      >(Prisma.sql`
          SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - dispatched_at)) / 60.0) AS avg, COUNT(*)::int AS n
          FROM shipments
          WHERE delivered_at >= ${range.from} AND delivered_at < ${range.to} AND dispatched_at IS NOT NULL`),
      this.prisma.order.count({ where: { status: 'PARTIALLY_SHIPPED' } }),
      this.prisma.order.count({
        where: {
          status: { in: [...ORDER_DELAYABLE_STATUSES] },
          targetDeliveryDate: { lt: now },
        },
      }),
      this.prisma.shipment.count({
        where: {
          status: { in: ['READY', 'DISPATCHED', 'IN_TRANSIT'] },
          scheduledAt: { lt: now },
        },
      }),
    ]);
    const o = (st: string) =>
      open.find((x) => x.status === st)?._count._all ?? 0;
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      range,
      shipments: {
        draft: o('DRAFT'),
        ready: o('READY'),
        dispatched: o('DISPATCHED'),
        inTransit: o('IN_TRANSIT'),
        failed: o('FAILED'),
        deliveredInRange: delivered,
        returnedInRange: returned,
      },
      averageDispatchToDeliveryMinutes: roundMin(dispatchToDelivery[0]?.avg),
      dispatchToDeliveryMeasured: num(dispatchToDelivery[0]?.n),
      partialDeliveryOrders: partial,
      overdueDeliveryCommitments: {
        ordersPastTargetDate: overdueOrders,
        shipmentsPastScheduledDate: overdueShipments,
      },
      definitions: {
        ready:
          'snapshot: READY, DISPATCHED, IN_TRANSIT and FAILED are shipments open right now',
        overdueDeliveryCommitments:
          'live orders past targetDeliveryDate; unfinished shipments past their scheduled date',
      },
    };
  }

  // ───────────────────────── bottlenecks ─────────────────────────

  /**
   * Where work waits. Ordered by `totalWaitMinutes` = time stages spent READY before starting (started in
   * the range) + how long the stages queued right now have already waited. Descriptive only: a long
   * wait shows where work accumulates, not why.
   */
  async bottlenecks(q: { from?: string; to?: string }) {
    const now = this.ctx.now();
    const range = this.ctx.range(q);
    const rows = await this.prisma.$queryRaw<
      {
        code: string;
        name: string;
        department: string;
        completed: number;
        avg_duration: Prisma.Decimal | null;
        started: number;
        avg_wait: Prisma.Decimal | null;
        wait_started: Prisma.Decimal | null;
        queued: number;
        queued_wait: Prisma.Decimal | null;
        blocked: number;
        overdue: number;
        queued_jobs: number;
      }[]
    >(Prisma.sql`
      SELECT js.stage_code AS code, MAX(js.stage_name) AS name, MAX(js.department_type::text) AS department,
        COUNT(*) FILTER (WHERE js.status = 'COMPLETED' AND js.started_at IS NOT NULL AND js.completed_at >= ${range.from} AND js.completed_at < ${range.to})::int AS completed,
        AVG(EXTRACT(EPOCH FROM (js.completed_at - js.started_at)) / 60.0)
          FILTER (WHERE js.status = 'COMPLETED' AND js.started_at IS NOT NULL AND js.completed_at >= ${range.from} AND js.completed_at < ${range.to}) AS avg_duration,
        COUNT(*) FILTER (WHERE js.started_at >= ${range.from} AND js.started_at < ${range.to} AND js.ready_at IS NOT NULL)::int AS started,
        AVG(EXTRACT(EPOCH FROM (js.started_at - js.ready_at)) / 60.0)
          FILTER (WHERE js.started_at >= ${range.from} AND js.started_at < ${range.to} AND js.ready_at IS NOT NULL) AS avg_wait,
        SUM(EXTRACT(EPOCH FROM (js.started_at - js.ready_at)) / 60.0)
          FILTER (WHERE js.started_at >= ${range.from} AND js.started_at < ${range.to} AND js.ready_at IS NOT NULL) AS wait_started,
        COUNT(*) FILTER (WHERE js.status = 'READY' AND js.superseded_at IS NULL AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS queued,
        SUM(EXTRACT(EPOCH FROM (${now} - js.ready_at)) / 60.0)
          FILTER (WHERE js.status = 'READY' AND js.superseded_at IS NULL AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD') AND js.ready_at IS NOT NULL) AS queued_wait,
        COUNT(*) FILTER (WHERE js.status = 'BLOCKED' AND js.superseded_at IS NULL AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS blocked,
        COUNT(*) FILTER (WHERE js.status IN ('READY', 'IN_PROGRESS', 'BLOCKED') AND js.superseded_at IS NULL AND NOT js.is_on_hold AND js.due_at < ${now} AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS overdue,
        COUNT(DISTINCT js.job_id) FILTER (WHERE js.status = 'READY' AND js.superseded_at IS NULL AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS queued_jobs
      FROM job_stages js JOIN factory_jobs fj ON fj.id = js.job_id
      GROUP BY js.stage_code`);
    const [qc, rework] = await Promise.all([
      this.prisma.$queryRaw<
        { code: string; inspections: number; failures: number }[]
      >(Prisma.sql`
        SELECT js.stage_code AS code, COUNT(*)::int AS inspections,
               COUNT(*) FILTER (WHERE qi.overall_result = 'FAIL')::int AS failures
        FROM qc_inspections qi JOIN job_stages js ON js.id = qi.job_stage_id
        WHERE qi.status = 'COMPLETED' AND qi.completed_at >= ${range.from} AND qi.completed_at < ${range.to}
        GROUP BY js.stage_code`),
      this.prisma.$queryRaw<{ code: string; reworks: number }[]>(Prisma.sql`
        SELECT d.code, COUNT(*)::int AS reworks
        FROM rework_records rw JOIN production_stage_definitions d ON d.id = rw.target_stage_definition_id
        WHERE rw.created_at >= ${range.from} AND rw.created_at < ${range.to} AND rw.status <> 'CANCELLED'
        GROUP BY d.code`),
    ]);
    const qcBy = new Map(qc.map((x) => [x.code, x]));
    const rwBy = new Map(rework.map((x) => [x.code, num(x.reworks)]));
    const stages = rows
      .map((r) => {
        const completed = num(r.completed);
        const totalWait = Math.round(
          Number(r.wait_started ?? 0) + Number(r.queued_wait ?? 0),
        );
        const insp = qcBy.get(r.code);
        const reworks = rwBy.get(r.code) ?? 0;
        return {
          stageCode: r.code,
          stageName: r.name,
          department: r.department,
          completedInRange: completed,
          averageDurationMinutes: roundMin(r.avg_duration),
          startedInRange: num(r.started),
          averageWaitBeforeStartMinutes: roundMin(r.avg_wait),
          queuedNow: num(r.queued),
          queuedJobsNow: num(r.queued_jobs),
          blockedNow: num(r.blocked),
          overdueNow: num(r.overdue),
          qcInspections: insp ? num(insp.inspections) : null,
          qcFailureRatePercent: insp
            ? pct(num(insp.failures), num(insp.inspections))
            : null,
          reworkTargeted: reworks,
          reworkRatePercent: pct(reworks, completed),
          totalWaitMinutes: totalWait,
        };
      })
      .filter(
        (s) =>
          s.completedInRange > 0 ||
          s.startedInRange > 0 ||
          s.queuedNow > 0 ||
          s.blockedNow > 0 ||
          s.overdueNow > 0,
      )
      .sort(
        (a, b) =>
          b.totalWaitMinutes - a.totalWaitMinutes ||
          b.overdueNow - a.overdueNow ||
          a.stageCode.localeCompare(b.stageCode),
      );
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      range,
      orderedBy: 'totalWaitMinutes',
      definitions: {
        totalWaitMinutes:
          'minutes stages waited in READY before starting (started in range) + minutes the stages queued now have waited so far',
        reworkRatePercent:
          'rework records targeting the stage created in the range ÷ stages of that stage completed in the range',
      },
      caution:
        'Descriptive only. Waiting time shows where work accumulates; it does not prove why.',
      stages,
    };
  }
}
