import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Prisma,
  type CapacityUnit,
  type DepartmentCapacity,
  type DepartmentType,
  type StaffCapacity,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateDepartmentCapacityDto,
  CreateStaffCapacityDto,
  UpdateDepartmentCapacityDto,
  UpdateStaffCapacityDto,
  UtilizationQueryDto,
} from './dto/management.dto.js';
import { ACCOUNTED_JOINS, RELEASED_STAGE, REMAINING_UNITS } from './sql.js';
import { ManagementContext } from './management-context.service.js';
import { addDays, dayKeys } from './pure/business-time.js';
import {
  demandDay,
  effectiveOn,
  utilizationFor,
  type CapacityConfig,
  type DayUtilization,
} from './pure/capacity.js';

const key = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const date = (s: string) => new Date(`${s}T00:00:00.000Z`);
const MAX_UTILIZATION_DAYS = 31;

const deptView = (c: DepartmentCapacity) => ({
  id: c.id,
  departmentType: c.departmentType,
  stageDefinitionId: c.stageDefinitionId,
  capacityUnit: c.capacityUnit,
  dailyCapacity: c.dailyCapacity,
  workingMinutesPerDay: c.workingMinutesPerDay,
  notes: c.notes,
  active: c.active,
  effectiveFrom: key(c.effectiveFrom)!,
  effectiveTo: key(c.effectiveTo),
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});
const staffView = (c: StaffCapacity) => ({
  id: c.id,
  userId: c.userId,
  stageDefinitionId: c.stageDefinitionId,
  workingMinutesPerDay: c.workingMinutesPerDay,
  active: c.active,
  effectiveFrom: key(c.effectiveFrom)!,
  effectiveTo: key(c.effectiveTo),
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

interface DemandRow {
  department: DepartmentType;
  stage_definition_id: string;
  day: Date;
  jobs: number;
  pieces: number;
  minutes: number;
}

@Injectable()
export class CapacityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ctx: ManagementContext,
  ) {}

  // ───────────────────────── configuration ─────────────────────────

  async listDepartments(f: {
    department?: DepartmentType;
    activeOnly?: boolean;
  }) {
    const rows = await this.prisma.departmentCapacity.findMany({
      where: {
        departmentType: f.department,
        active: f.activeOnly ? true : undefined,
      },
      orderBy: [{ departmentType: 'asc' }, { effectiveFrom: 'asc' }],
    });
    return rows.map(deptView);
  }

  private async assertDefinitionInDepartment(
    tx: Prisma.TransactionClient,
    departmentType: DepartmentType,
    stageDefinitionId?: string | null,
  ) {
    if (!stageDefinitionId) return;
    const def = await tx.productionStageDefinition.findUnique({
      where: { id: stageDefinitionId },
    });
    if (!def) throw new BadRequestException('Unknown stage definition');
    if (def.departmentType !== departmentType)
      throw new BadRequestException(
        `${def.code} belongs to ${def.departmentType}, not ${departmentType}`,
      );
  }

  /** Two active ranges of the same scope may not overlap: utilization would double count. */
  private async assertNoOverlap(
    tx: Prisma.TransactionClient,
    scope: { departmentType: DepartmentType; stageDefinitionId: string | null },
    from: string,
    to: string | null,
    exceptId?: string,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dept-capacity:${scope.departmentType}:${scope.stageDefinitionId ?? '*'}`}))`;
    const clash = await tx.departmentCapacity.findFirst({
      where: {
        active: true,
        departmentType: scope.departmentType,
        stageDefinitionId: scope.stageDefinitionId,
        id: exceptId ? { not: exceptId } : undefined,
        effectiveFrom: to ? { lte: date(to) } : undefined,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date(from) } }],
      },
    });
    if (clash)
      throw new ConflictException(
        `Capacity ${clash.id} already covers ${key(clash.effectiveFrom)} – ${key(clash.effectiveTo) ?? 'open end'} for this scope; end it first`,
      );
  }

  private static order(from: string, to: string | null | undefined) {
    if (to && to < from)
      throw new BadRequestException(
        'effectiveTo must not be before effectiveFrom',
      );
  }

  async createDepartment(
    dto: CreateDepartmentCapacityDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    CapacityService.order(dto.effectiveFrom, dto.effectiveTo);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.assertDefinitionInDepartment(
        tx,
        dto.departmentType,
        dto.stageDefinitionId,
      );
      await this.assertNoOverlap(
        tx,
        {
          departmentType: dto.departmentType,
          stageDefinitionId: dto.stageDefinitionId ?? null,
        },
        dto.effectiveFrom,
        dto.effectiveTo ?? null,
      );
      const c = await tx.departmentCapacity.create({
        data: {
          departmentType: dto.departmentType,
          stageDefinitionId: dto.stageDefinitionId,
          capacityUnit: dto.capacityUnit,
          dailyCapacity: dto.dailyCapacity,
          workingMinutesPerDay: dto.workingMinutesPerDay,
          notes: dto.notes,
          effectiveFrom: date(dto.effectiveFrom),
          effectiveTo: dto.effectiveTo ? date(dto.effectiveTo) : null,
          createdByUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.DEPARTMENT_CAPACITY_CREATED,
          entityType: 'DepartmentCapacity',
          entityId: c.id,
          metadata: deptView(c) as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return c;
    });
    return deptView(row);
  }

  async updateDepartment(
    id: string,
    dto: UpdateDepartmentCapacityDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const row = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.departmentCapacity.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Capacity not found');
      const from = dto.effectiveFrom ?? key(cur.effectiveFrom)!;
      const to =
        dto.effectiveTo === undefined ? key(cur.effectiveTo) : dto.effectiveTo;
      CapacityService.order(from, to);
      const active = dto.active ?? cur.active;
      if (active)
        await this.assertNoOverlap(
          tx,
          {
            departmentType: cur.departmentType,
            stageDefinitionId: cur.stageDefinitionId,
          },
          from,
          to,
          id,
        );
      const data: Prisma.DepartmentCapacityUncheckedUpdateInput = {};
      if (dto.dailyCapacity !== undefined)
        data.dailyCapacity = dto.dailyCapacity;
      if (dto.workingMinutesPerDay !== undefined)
        data.workingMinutesPerDay = dto.workingMinutesPerDay;
      if (dto.notes !== undefined) data.notes = dto.notes;
      if (dto.effectiveFrom !== undefined)
        data.effectiveFrom = date(dto.effectiveFrom);
      if (dto.effectiveTo !== undefined)
        data.effectiveTo = dto.effectiveTo ? date(dto.effectiveTo) : null;
      if (dto.active !== undefined) data.active = dto.active;
      if (Object.keys(data).length === 0)
        throw new BadRequestException('Nothing to update');
      const next = await tx.departmentCapacity.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action:
            dto.active === false
              ? AuditAction.DEPARTMENT_CAPACITY_DEACTIVATED
              : AuditAction.DEPARTMENT_CAPACITY_UPDATED,
          entityType: 'DepartmentCapacity',
          entityId: id,
          metadata: {
            before: deptView(cur),
            after: deptView(next),
          } as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return next;
    });
    return deptView(row);
  }

  deactivateDepartment(id: string, actor: AuthUser, meta: RequestMeta) {
    return this.updateDepartment(id, { active: false }, actor, meta);
  }

  async listStaff(f: { userId?: string }) {
    const rows = await this.prisma.staffCapacity.findMany({
      where: { userId: f.userId },
      orderBy: [{ userId: 'asc' }, { effectiveFrom: 'asc' }],
    });
    return rows.map(staffView);
  }

  async createStaff(
    dto: CreateStaffCapacityDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    CapacityService.order(dto.effectiveFrom, dto.effectiveTo);
    const row = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: dto.userId, deletedAt: null },
      });
      if (!user) throw new BadRequestException('Unknown user');
      if (dto.stageDefinitionId) {
        const def = await tx.productionStageDefinition.findUnique({
          where: { id: dto.stageDefinitionId },
        });
        if (!def) throw new BadRequestException('Unknown stage definition');
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-capacity:${dto.userId}:${dto.stageDefinitionId ?? '*'}`}))`;
      const clash = await tx.staffCapacity.findFirst({
        where: {
          active: true,
          userId: dto.userId,
          stageDefinitionId: dto.stageDefinitionId ?? null,
          effectiveFrom: dto.effectiveTo
            ? { lte: date(dto.effectiveTo) }
            : undefined,
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gte: date(dto.effectiveFrom) } },
          ],
        },
      });
      if (clash)
        throw new ConflictException(
          `Staff capacity ${clash.id} already covers part of this range`,
        );
      const c = await tx.staffCapacity.create({
        data: {
          userId: dto.userId,
          stageDefinitionId: dto.stageDefinitionId,
          workingMinutesPerDay: dto.workingMinutesPerDay,
          effectiveFrom: date(dto.effectiveFrom),
          effectiveTo: dto.effectiveTo ? date(dto.effectiveTo) : null,
          createdByUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.STAFF_CAPACITY_CREATED,
          entityType: 'StaffCapacity',
          entityId: c.id,
          metadata: staffView(c) as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return c;
    });
    return staffView(row);
  }

  async updateStaff(
    id: string,
    dto: UpdateStaffCapacityDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const row = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.staffCapacity.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Staff capacity not found');
      const from = dto.effectiveFrom ?? key(cur.effectiveFrom)!;
      const to =
        dto.effectiveTo === undefined ? key(cur.effectiveTo) : dto.effectiveTo;
      CapacityService.order(from, to);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-capacity:${cur.userId}:${cur.stageDefinitionId ?? '*'}`}))`;
      if (dto.active ?? cur.active) {
        const clash = await tx.staffCapacity.findFirst({
          where: {
            active: true,
            id: { not: id },
            userId: cur.userId,
            stageDefinitionId: cur.stageDefinitionId,
            effectiveFrom: to ? { lte: date(to) } : undefined,
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: date(from) } }],
          },
        });
        if (clash)
          throw new ConflictException(
            `Staff capacity ${clash.id} already covers part of this range`,
          );
      }
      const data: Prisma.StaffCapacityUncheckedUpdateInput = {};
      if (dto.workingMinutesPerDay !== undefined)
        data.workingMinutesPerDay = dto.workingMinutesPerDay;
      if (dto.effectiveFrom !== undefined)
        data.effectiveFrom = date(dto.effectiveFrom);
      if (dto.effectiveTo !== undefined)
        data.effectiveTo = dto.effectiveTo ? date(dto.effectiveTo) : null;
      if (dto.active !== undefined) data.active = dto.active;
      if (Object.keys(data).length === 0)
        throw new BadRequestException('Nothing to update');
      const next = await tx.staffCapacity.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action:
            dto.active === false
              ? AuditAction.STAFF_CAPACITY_DEACTIVATED
              : AuditAction.STAFF_CAPACITY_UPDATED,
          entityType: 'StaffCapacity',
          entityId: id,
          metadata: {
            before: staffView(cur),
            after: staffView(next),
          } as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return next;
    });
    return staffView(row);
  }

  deactivateStaff(id: string, actor: AuthUser, meta: RequestMeta) {
    return this.updateStaff(id, { active: false }, actor, meta);
  }

  /** Minutes per day a person is configured for on `day` (null = nothing configured). */
  async staffMinutesPerDay(
    userIds: string[],
    day: string,
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.staffCapacity.findMany({
      where: {
        userId: { in: userIds },
        active: true,
        stageDefinitionId: null,
        effectiveFrom: { lte: date(day) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date(day) } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    const out = new Map<string, number>();
    for (const r of rows)
      if (!out.has(r.userId)) out.set(r.userId, r.workingMinutesPerDay);
    return out;
  }

  // ───────────────────────── utilization ─────────────────────────

  async utilization(q: UtilizationQueryDto) {
    const today = this.ctx.todayKey();
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 6);
    if (to < from) throw new BadRequestException('to must not be before from');
    const days = dayKeys(from, to);
    if (days.length > MAX_UTILIZATION_DAYS)
      throw new BadRequestException(
        `The range is limited to ${MAX_UTILIZATION_DAYS} days`,
      );

    const configs = await this.prisma.departmentCapacity.findMany({
      where: {
        active: true,
        departmentType: q.department,
        effectiveFrom: { lte: date(to) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date(from) } }],
      },
    });
    const demandRows = await this.demand(today, q.department);

    const defs = await this.prisma.productionStageDefinition.findMany({
      select: { id: true, code: true, name: true },
    });
    const defName = new Map(defs.map((d) => [d.id, d]));

    // demand per (department|definition) per day
    const dayDemand = (
      dept: DepartmentType,
      def: string | null,
      unit: CapacityUnit,
    ) => {
      const out = new Map<string, number>();
      for (const r of demandRows) {
        if (r.department !== dept || (def && r.stage_definition_id !== def))
          continue;
        const d = demandDay(r.day.toISOString().slice(0, 10), today, to);
        if (!d || d < from) continue;
        const v =
          unit === 'PIECES' ? r.pieces : unit === 'JOBS' ? r.jobs : r.minutes;
        out.set(d, (out.get(d) ?? 0) + v);
      }
      return out;
    };

    const scopes = new Map<string, DepartmentCapacity[]>();
    for (const c of configs) {
      const k = `${c.departmentType}|${c.stageDefinitionId ?? '*'}`;
      scopes.set(k, [...(scopes.get(k) ?? []), c]);
    }
    const series = [...scopes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, list]) => {
        const first = list[0]!;
        const asConfig: (CapacityConfig & { row: DepartmentCapacity })[] =
          list.map((c) => ({
            id: c.id,
            effectiveFrom: key(c.effectiveFrom)!,
            effectiveTo: key(c.effectiveTo),
            active: c.active,
            dailyCapacity: c.dailyCapacity,
            row: c,
          }));
        // units may differ between ranges of one scope: demand is read per day with that day's unit
        const perDay: (DayUtilization & {
          capacityUnit: CapacityUnit | null;
        })[] = days.map((day) => {
          const cfg = effectiveOn(asConfig, day);
          const unit = cfg?.row.capacityUnit ?? null;
          const demand = unit
            ? (dayDemand(
                first.departmentType,
                first.stageDefinitionId,
                unit,
              ).get(day) ?? 0)
            : 0;
          return {
            ...utilizationFor(day, demand, cfg?.dailyCapacity ?? null),
            capacityUnit: unit,
          };
        });
        return {
          departmentType: first.departmentType,
          stageDefinitionId: first.stageDefinitionId,
          stageCode: first.stageDefinitionId
            ? (defName.get(first.stageDefinitionId)?.code ?? null)
            : null,
          days: perDay,
          overloadedDays: perDay.filter((d) => d.overloaded).length,
        };
      });

    const configured = new Set(configs.map((c) => c.departmentType));
    const unconfigured = [...new Set(demandRows.map((r) => r.department))]
      .filter((d) => !configured.has(d))
      .sort()
      .map((department) => ({
        department,
        openJobs: demandRows
          .filter((r) => r.department === department)
          .reduce((n, r) => n + r.jobs, 0),
        pieces: demandRows
          .filter((r) => r.department === department)
          .reduce((n, r) => n + r.pieces, 0),
      }));
    return {
      timezone: this.ctx.timezone,
      from,
      to,
      generatedAt: this.ctx.now(),
      assumptions: [
        'Every calendar day is a working day',
        'Demand = remaining work of released (READY / IN_PROGRESS / BLOCKED) stages, placed on the day each stage is due; overdue or undated stages count today',
        'Sample jobs have no planned quantity: they count as jobs and minutes, not pieces',
        'A day without configured capacity has no utilization',
      ],
      series,
      departmentsWithoutCapacity: unconfigured,
    };
  }

  private demand(today: string, department?: DepartmentType) {
    const tz = this.ctx.timezone;
    return this.prisma.$queryRaw<DemandRow[]>(Prisma.sql`
      SELECT js.department_type::text AS department,
             js.stage_definition_id::text AS stage_definition_id,
             CASE WHEN js.due_at IS NULL
                    OR ((js.due_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date < ${today}::date
                  THEN ${today}::date
                  ELSE ((js.due_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date END AS day,
             COUNT(DISTINCT js.job_id)::int AS jobs,
             COALESCE(SUM(${REMAINING_UNITS}), 0)::int AS pieces,
             COALESCE(SUM(js.expected_duration_minutes), 0)::int AS minutes
      FROM job_stages js
      JOIN factory_jobs fj ON fj.id = js.job_id
      ${ACCOUNTED_JOINS}
      WHERE ${RELEASED_STAGE}
        ${department ? Prisma.sql`AND js.department_type = ${department}::"DepartmentType"` : Prisma.empty}
      GROUP BY 1, 2, 3`);
  }
}
