import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type DepartmentType } from '../../generated/prisma/client.js';
import { paginated } from '../../common/types/paginated.js';
import type { StaffWorkloadQueryDto } from './dto/management.dto.js';
import { CapacityService } from './capacity.service.js';
import { ManagementContext } from './management-context.service.js';
import {
  ACCOUNTED_JOINS,
  NO_ACTIVE_ASSIGNMENT,
  PLANNED_UNITS,
  RELEASED_STAGE,
  REMAINING_UNITS,
  num,
} from './sql.js';

const DEPARTMENTS: DepartmentType[] = [
  'FABRIC',
  'PATTERN',
  'CUTTING',
  'PRINTING',
  'SEWING',
  'QC',
  'PACKAGING',
  'GENERAL',
];

interface DeptRow {
  department: DepartmentType;
  ready: number;
  in_progress: number;
  blocked: number;
  jobs: number;
  planned: number;
  remaining: number;
  overdue: number;
  unassigned_ready: number;
  staff: number;
}

interface WipRow {
  stage_definition_id: string;
  queued: number;
  queued_units: number;
  active: number;
  active_units: number;
  blocked: number;
  blocked_units: number;
  queued_jobs: number;
  active_jobs: number;
  blocked_jobs: number;
}

interface StaffRow {
  user_id: string;
  active: number;
  ready: number;
  in_progress: number;
  blocked: number;
  overdue: number;
  planned_qty: number;
  expected_minutes: number;
  completed: number;
  avg_minutes: Prisma.Decimal | number | null;
  on_time: number;
  with_due: number;
}

@Injectable()
export class WorkloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
    private readonly capacity: CapacityService,
  ) {}

  // ───────────────────────── departments ─────────────────────────

  /**
   * Workload of released work per department. Stage counts are current occurrences only (rework
   * attempts replace the failed one), paused jobs/stages are left out, and units come from the job's
   * planned quantity (sample jobs have none, so they count as stages but not as units).
   */
  async departments() {
    const now = this.ctx.now();
    const [rows, eligible, shipments] = await Promise.all([
      this.prisma.$queryRaw<DeptRow[]>(Prisma.sql`
        SELECT js.department_type::text AS department,
          COUNT(*) FILTER (WHERE js.status = 'READY')::int AS ready,
          COUNT(*) FILTER (WHERE js.status = 'IN_PROGRESS')::int AS in_progress,
          COUNT(*) FILTER (WHERE js.status = 'BLOCKED')::int AS blocked,
          COUNT(DISTINCT js.job_id)::int AS jobs,
          COALESCE(SUM(${PLANNED_UNITS}), 0)::int AS planned,
          COALESCE(SUM(${REMAINING_UNITS}), 0)::int AS remaining,
          COUNT(*) FILTER (WHERE js.due_at < ${now})::int AS overdue,
          COUNT(*) FILTER (WHERE js.status = 'READY' AND js.requires_assignment AND ${NO_ACTIVE_ASSIGNMENT})::int AS unassigned_ready,
          (SELECT COUNT(DISTINCT sa.user_id) FROM stage_assignments sa
             JOIN job_stages js2 ON js2.id = sa.job_stage_id
             JOIN factory_jobs fj2 ON fj2.id = js2.job_id
            WHERE sa.removed_at IS NULL AND js2.department_type = js.department_type
              AND js2.superseded_at IS NULL AND js2.status IN ('READY', 'IN_PROGRESS', 'BLOCKED')
              AND fj2.status NOT IN ('COMPLETED', 'CANCELLED'))::int AS staff
        FROM job_stages js
        JOIN factory_jobs fj ON fj.id = js.job_id
        ${ACCOUNTED_JOINS}
        WHERE ${RELEASED_STAGE}
        GROUP BY js.department_type`),
      this.eligibleStaff(),
      this.deliveryRow(now),
    ]);
    const byDept = new Map(rows.map((r) => [r.department, r]));
    const out = DEPARTMENTS.map((d) => {
      const r = byDept.get(d);
      return {
        department: d as DepartmentType | 'DELIVERY',
        readyStages: num(r?.ready),
        inProgressStages: num(r?.in_progress),
        blockedStages: num(r?.blocked),
        jobsInvolved: num(r?.jobs),
        plannedUnits: num(r?.planned),
        remainingUnits: num(r?.remaining),
        overdueStages: num(r?.overdue),
        unassignedReadyStages: num(r?.unassigned_ready),
        assignedStaffCount: num(r?.staff),
        eligibleStaffCount: eligible.get(d) ?? null,
      };
    });
    out.push(shipments);
    return {
      generatedAt: now,
      note: 'Paused jobs and stages are excluded. plannedUnits / remainingUnits count bulk work only; DELIVERY is derived from shipments (ready = READY, in progress = DISPATCHED / IN_TRANSIT, blocked = FAILED).',
      departments: out,
    };
  }

  /** Staff who could work a department, from the eligible role codes of its active stage definitions. */
  private async eligibleStaff(): Promise<Map<DepartmentType, number>> {
    const defs = await this.prisma.productionStageDefinition.findMany({
      where: { isActive: true, archivedAt: null },
      select: { departmentType: true, eligibleRoleCodes: true },
    });
    const roleCodes = new Map<DepartmentType, Set<string>>();
    for (const d of defs) {
      const set = roleCodes.get(d.departmentType) ?? new Set<string>();
      d.eligibleRoleCodes.forEach((c) => set.add(c));
      roleCodes.set(d.departmentType, set);
    }
    const out = new Map<DepartmentType, number>();
    for (const [dept, codes] of roleCodes) {
      if (codes.size === 0) continue; // "any staff": not a meaningful number
      out.set(
        dept,
        await this.prisma.user.count({
          where: {
            deletedAt: null,
            isActive: true,
            roles: { some: { role: { code: { in: [...codes] } } } },
          },
        }),
      );
    }
    return out;
  }

  private async deliveryRow(now: Date) {
    const [counts, units, staff, overdue] = await Promise.all([
      this.prisma.shipment.groupBy({
        by: ['status'],
        where: {
          status: { in: ['READY', 'DISPATCHED', 'IN_TRANSIT', 'FAILED'] },
        },
        _count: { _all: true },
      }),
      this.prisma.shipmentLine.aggregate({
        where: {
          shipment: {
            status: { in: ['READY', 'DISPATCHED', 'IN_TRANSIT', 'FAILED'] },
          },
        },
        _sum: { quantity: true },
      }),
      this.prisma.shipment.findMany({
        where: {
          status: { in: ['READY', 'DISPATCHED', 'IN_TRANSIT', 'FAILED'] },
          assignedDeliveryUserId: { not: null },
        },
        distinct: ['assignedDeliveryUserId'],
        select: { assignedDeliveryUserId: true },
      }),
      this.prisma.shipment.count({
        where: {
          status: { in: ['READY', 'DISPATCHED', 'IN_TRANSIT'] },
          scheduledAt: { lt: now },
        },
      }),
    ]);
    const c = (s: string) =>
      counts.find((x) => x.status === s)?._count._all ?? 0;
    return {
      department: 'DELIVERY' as DepartmentType | 'DELIVERY',
      readyStages: c('READY'),
      inProgressStages: c('DISPATCHED') + c('IN_TRANSIT'),
      blockedStages: c('FAILED'),
      jobsInvolved: 0,
      plannedUnits: units._sum.quantity ?? 0,
      remainingUnits: units._sum.quantity ?? 0,
      overdueStages: overdue,
      unassignedReadyStages: 0,
      assignedStaffCount: staff.length,
      eligibleStaffCount: null as number | null,
    };
  }

  // ───────────────────────── WIP ─────────────────────────

  /** Queue / work-in-progress per stage definition (released work, current occurrences). */
  async wip() {
    const now = this.ctx.now();
    const todayStart = this.ctx.todayStart(now);
    const [defs, rows, upcoming, done] = await Promise.all([
      this.prisma.productionStageDefinition.findMany({
        where: { isActive: true, archivedAt: null },
        orderBy: [{ defaultSequence: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.$queryRaw<WipRow[]>(Prisma.sql`
        SELECT js.stage_definition_id::text AS stage_definition_id,
          COUNT(*) FILTER (WHERE js.status = 'READY')::int AS queued,
          COALESCE(SUM(${PLANNED_UNITS}) FILTER (WHERE js.status = 'READY'), 0)::int AS queued_units,
          COUNT(DISTINCT js.job_id) FILTER (WHERE js.status = 'READY')::int AS queued_jobs,
          COUNT(*) FILTER (WHERE js.status = 'IN_PROGRESS')::int AS active,
          COALESCE(SUM(${PLANNED_UNITS}) FILTER (WHERE js.status = 'IN_PROGRESS'), 0)::int AS active_units,
          COUNT(DISTINCT js.job_id) FILTER (WHERE js.status = 'IN_PROGRESS')::int AS active_jobs,
          COUNT(*) FILTER (WHERE js.status = 'BLOCKED')::int AS blocked,
          COALESCE(SUM(${PLANNED_UNITS}) FILTER (WHERE js.status = 'BLOCKED'), 0)::int AS blocked_units,
          COUNT(DISTINCT js.job_id) FILTER (WHERE js.status = 'BLOCKED')::int AS blocked_jobs
        FROM job_stages js
        JOIN factory_jobs fj ON fj.id = js.job_id
        LEFT JOIN rework_records rw ON rw.id = js.rework_record_id
        WHERE ${RELEASED_STAGE}
        GROUP BY js.stage_definition_id`),
      this.prisma.jobStage.groupBy({
        by: ['stageDefinitionId'],
        where: {
          supersededAt: null,
          status: 'WAITING',
          job: { status: { notIn: ['COMPLETED', 'CANCELLED', 'ON_HOLD'] } },
        },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<
        { stage_definition_id: string; stages: number; units: number }[]
      >(Prisma.sql`
        SELECT js.stage_definition_id::text AS stage_definition_id, COUNT(*)::int AS stages,
               COALESCE(SUM(fj.planned_quantity), 0)::int AS units
        FROM job_stages js JOIN factory_jobs fj ON fj.id = js.job_id
        WHERE js.status = 'COMPLETED' AND js.completed_at >= ${todayStart} AND js.completed_at <= ${now}
        GROUP BY js.stage_definition_id`),
    ]);
    const byDef = new Map(rows.map((r) => [r.stage_definition_id, r]));
    const waiting = new Map(
      upcoming.map((u) => [u.stageDefinitionId, u._count._all]),
    );
    const completed = new Map(done.map((d) => [d.stage_definition_id, d]));
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      todayStartsAt: todayStart,
      stages: defs.map((d) => {
        const r = byDef.get(d.id);
        const c = completed.get(d.id);
        return {
          stageCode: d.code,
          stageName: d.name,
          department: d.departmentType,
          sequence: d.defaultSequence,
          queued: {
            stages: num(r?.queued),
            jobs: num(r?.queued_jobs),
            units: num(r?.queued_units),
          },
          active: {
            stages: num(r?.active),
            jobs: num(r?.active_jobs),
            units: num(r?.active_units),
          },
          blocked: {
            stages: num(r?.blocked),
            jobs: num(r?.blocked_jobs),
            units: num(r?.blocked_units),
          },
          upcomingStages: waiting.get(d.id) ?? 0,
          completedToday: { stages: num(c?.stages), units: num(c?.units) },
        };
      }),
    };
  }

  // ───────────────────────── staff ─────────────────────────

  private staffRows(
    range: { from: Date; to: Date },
    now: Date,
    filter: { userId?: string; department?: DepartmentType },
  ) {
    return this.prisma.$queryRaw<StaffRow[]>(Prisma.sql`
      SELECT sa.user_id::text AS user_id,
        COUNT(*) FILTER (WHERE js.status IN ('READY', 'IN_PROGRESS', 'BLOCKED') AND NOT js.is_on_hold AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS active,
        COUNT(*) FILTER (WHERE js.status = 'READY' AND NOT js.is_on_hold AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS ready,
        COUNT(*) FILTER (WHERE js.status = 'IN_PROGRESS' AND NOT js.is_on_hold AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS in_progress,
        COUNT(*) FILTER (WHERE js.status = 'BLOCKED' AND NOT js.is_on_hold AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS blocked,
        COUNT(*) FILTER (WHERE js.status IN ('READY', 'IN_PROGRESS') AND js.due_at < ${now} AND NOT js.is_on_hold AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))::int AS overdue,
        COALESCE(SUM(COALESCE(fj.planned_quantity, 0)) FILTER (WHERE js.status IN ('READY', 'IN_PROGRESS', 'BLOCKED') AND NOT js.is_on_hold AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD')), 0)::int AS planned_qty,
        COALESCE(SUM(COALESCE(js.expected_duration_minutes, 0)) FILTER (WHERE js.status IN ('READY', 'IN_PROGRESS', 'BLOCKED') AND NOT js.is_on_hold AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD')), 0)::int AS expected_minutes,
        COUNT(*) FILTER (WHERE js.status = 'COMPLETED' AND js.completed_at >= ${range.from} AND js.completed_at < ${range.to})::int AS completed,
        AVG(EXTRACT(EPOCH FROM (js.completed_at - js.started_at)) / 60.0)
          FILTER (WHERE js.status = 'COMPLETED' AND js.completed_at >= ${range.from} AND js.completed_at < ${range.to} AND js.started_at IS NOT NULL) AS avg_minutes,
        COUNT(*) FILTER (WHERE js.status = 'COMPLETED' AND js.completed_at >= ${range.from} AND js.completed_at < ${range.to} AND js.due_at IS NOT NULL AND js.completed_at <= js.due_at)::int AS on_time,
        COUNT(*) FILTER (WHERE js.status = 'COMPLETED' AND js.completed_at >= ${range.from} AND js.completed_at < ${range.to} AND js.due_at IS NOT NULL)::int AS with_due
      FROM stage_assignments sa
      JOIN job_stages js ON js.id = sa.job_stage_id
      JOIN factory_jobs fj ON fj.id = js.job_id
      JOIN users u ON u.id = sa.user_id
      WHERE sa.removed_at IS NULL AND js.superseded_at IS NULL AND u.deleted_at IS NULL
        ${filter.userId ? Prisma.sql`AND sa.user_id = ${filter.userId}::uuid` : Prisma.empty}
        ${filter.department ? Prisma.sql`AND js.department_type = ${filter.department}::"DepartmentType"` : Prisma.empty}
        AND (js.status IN ('READY', 'IN_PROGRESS', 'BLOCKED')
             OR (js.status = 'COMPLETED' AND js.completed_at >= ${range.from} AND js.completed_at < ${range.to}))
      GROUP BY sa.user_id`);
  }

  /**
   * Operational workload and delivery performance per assigned staff member, for factory planning.
   * Deliberately no score, no ranking and no cross-person comparison: rows are ordered by name.
   */
  async staff(q: StaffWorkloadQueryDto) {
    const now = this.ctx.now();
    const range = this.ctx.range(q);
    const rows = await this.staffRows(range, now, { department: q.department });
    const ids = rows.map((r) => r.user_id);
    const [users, produced, reworks, capacity] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          roles: { select: { role: { select: { code: true } } } },
        },
      }),
      this.prisma.stageProductionReport.groupBy({
        by: ['reportedByUserId'],
        where: {
          reportedByUserId: { in: ids },
          createdAt: { gte: range.from, lt: range.to },
        },
        _sum: { producedQuantity: true, rejectedQuantity: true },
      }),
      this.prisma.reworkRecord.findMany({
        where: {
          createdAt: { gte: range.from, lt: range.to },
          failedStage: {
            assignments: { some: { userId: { in: ids }, removedAt: null } },
          },
        },
        select: {
          failedStage: {
            select: {
              assignments: {
                where: { removedAt: null },
                select: { userId: true },
              },
            },
          },
        },
      }),
      this.capacity.staffMinutesPerDay(ids, this.ctx.todayKey(now)),
    ]);
    const name = new Map(users.map((u) => [u.id, u]));
    const prod = new Map(produced.map((p) => [p.reportedByUserId, p._sum]));
    const rework = new Map<string, number>();
    for (const r of reworks)
      for (const a of r.failedStage.assignments)
        rework.set(a.userId, (rework.get(a.userId) ?? 0) + 1);
    const items = rows
      .map((r) => {
        const u = name.get(r.user_id);
        const p = prod.get(r.user_id);
        return {
          userId: r.user_id,
          name: u?.name ?? '',
          roles: u?.roles.map((x) => x.role.code).sort() ?? [],
          activeAssignments: num(r.active),
          readyAssignments: num(r.ready),
          inProgressAssignments: num(r.in_progress),
          blockedAssignments: num(r.blocked),
          overdueAssignments: num(r.overdue),
          plannedQuantity: num(r.planned_qty),
          assignedExpectedMinutes: num(r.expected_minutes),
          capacityMinutesPerDay: capacity.get(r.user_id) ?? null,
          stagesCompleted: num(r.completed),
          producedQuantity: p?.producedQuantity ?? 0,
          rejectedQuantity: p?.rejectedQuantity ?? 0,
          averageCompletionMinutes:
            r.avg_minutes == null ? null : Math.round(Number(r.avg_minutes)),
          onTimeCompletionRate: num(r.with_due)
            ? Math.round((num(r.on_time) / num(r.with_due)) * 1000) / 10
            : null,
          reworkOnAssignedStages: rework.get(r.user_id) ?? 0,
        };
      })
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
      );
    const page = items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return {
      ...paginated(page, q.page, q.pageSize, items.length),
      range: { from: range.from, to: range.to },
      note: 'Operational planning data only: no score and no ranking. Completed counts use stages the person is still assigned to.',
    };
  }

  /** The caller's own workload and nothing else. */
  async mine(userId: string) {
    const now = this.ctx.now();
    const todayStart = this.ctx.todayStart(now);
    const soon = new Date(
      now.getTime() + this.ctx.cfg.dueSoonHours * 3_600_000,
    );
    const [rows, dueSoon, next] = await Promise.all([
      this.staffRows(
        { from: todayStart, to: new Date(now.getTime() + 1) },
        now,
        { userId },
      ),
      this.prisma.jobStage.count({
        where: {
          supersededAt: null,
          isOnHold: false,
          status: { in: ['READY', 'IN_PROGRESS'] },
          dueAt: { gte: now, lte: soon },
          assignments: { some: { userId, removedAt: null } },
          job: { status: { notIn: ['COMPLETED', 'CANCELLED', 'ON_HOLD'] } },
        },
      }),
      this.prisma.jobStage.findMany({
        where: {
          supersededAt: null,
          isOnHold: false,
          status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
          assignments: { some: { userId, removedAt: null } },
          job: { status: { notIn: ['COMPLETED', 'CANCELLED', 'ON_HOLD'] } },
        },
        orderBy: [
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        take: 5,
        select: {
          id: true,
          stageName: true,
          status: true,
          dueAt: true,
          job: { select: { id: true, jobNumber: true, productName: true } },
        },
      }),
    ]);
    const r = rows[0];
    return {
      generatedAt: now,
      timezone: this.ctx.timezone,
      ready: num(r?.ready),
      inProgress: num(r?.in_progress),
      blocked: num(r?.blocked),
      overdue: num(r?.overdue),
      dueSoon,
      dueSoonWindowHours: this.ctx.cfg.dueSoonHours,
      completedToday: num(r?.completed),
      nextUp: next.map((s) => ({
        stageId: s.id,
        stageName: s.stageName,
        status: s.status,
        dueAt: s.dueAt,
        jobId: s.job.id,
        jobNumber: s.job.jobNumber,
        productName: s.job.productName,
      })),
    };
  }
}
