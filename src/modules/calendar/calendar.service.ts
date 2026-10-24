import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  Prisma,
  WorkingCalendar,
  WorkingCalendarDay,
  WorkingCalendarException,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import {
  addDays,
  businessDayKey,
  dayKeys,
} from '../management/pure/business-time.js';
import {
  CALENDAR_TIME,
  formatHHMM,
  hoursFor,
  isAlwaysOpen,
  parseHHMM,
  workingClock,
  type BusinessClock,
  type DayHours,
  type WorkingSchedule,
} from '../management/pure/working-time.js';
import type {
  CalendarPreviewQueryDto,
  CreateWorkingCalendarDto,
  SetCalendarExceptionDto,
  UpdateWorkingCalendarDto,
  WorkingDayDto,
} from './dto/calendar.dto.js';

type Full = WorkingCalendar & {
  days: WorkingCalendarDay[];
  exceptions: WorkingCalendarException[];
};
const CACHE_MS = 30_000;
const dateOf = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Hours of one DTO day (validated), or null for a non-working day. */
function hoursOf(d: {
  isWorkingDay: boolean;
  startTime?: string;
  endTime?: string;
}): DayHours | null {
  if (!d.isWorkingDay) {
    if (d.startTime || d.endTime)
      throw new BadRequestException('A non-working day has no hours');
    return null;
  }
  if (!d.startTime || !d.endTime)
    throw new BadRequestException('A working day needs startTime and endTime');
  const start = parseHHMM(d.startTime);
  const end = parseHHMM(d.endTime);
  if (start >= end)
    throw new BadRequestException('startTime must be before endTime');
  return { start, end };
}

const view = (c: Full) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  timezone: c.timezone,
  isDefault: c.isDefault,
  active: c.active,
  days: [...c.days]
    .sort((a, b) => a.weekday - b.weekday)
    .map((d) => ({
      weekday: d.weekday,
      isWorkingDay: d.isWorkingDay,
      startTime: d.startMinute == null ? null : formatHHMM(d.startMinute),
      endTime: d.endMinute == null ? null : formatHHMM(d.endMinute),
    })),
  exceptions: [...c.exceptions]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((e) => ({
      date: keyOf(e.date),
      isWorkingDay: e.isWorkingDay,
      startTime: e.startMinute == null ? null : formatHHMM(e.startMinute),
      endTime: e.endMinute == null ? null : formatHHMM(e.endMinute),
      reason: e.reason,
    })),
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export const toSchedule = (c: Full): WorkingSchedule => {
  const weekly: (DayHours | null)[] = Array.from({ length: 7 }, () => null);
  for (const d of c.days)
    weekly[d.weekday] =
      d.isWorkingDay && d.startMinute != null && d.endMinute != null
        ? { start: d.startMinute, end: d.endMinute }
        : null;
  const exceptions = new Map<string, DayHours | null>();
  for (const e of c.exceptions)
    exceptions.set(
      keyOf(e.date),
      e.isWorkingDay && e.startMinute != null && e.endMinute != null
        ? { start: e.startMinute, end: e.endMinute }
        : null,
    );
  return { timezone: c.timezone, weekly, exceptions };
};

/** Default Sunday–Thursday 09:00–17:00; the seed uses an always-open calendar instead (see docs). */
const WORKWEEK: WorkingDayDto[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  isWorkingDay: weekday <= 4,
  startTime: weekday <= 4 ? '09:00' : undefined,
  endTime: weekday <= 4 ? '17:00' : undefined,
}));

/**
 * The factory working calendar: weekly hours plus holidays / exceptional / shortened days, in an IANA zone.
 * SLA, ETA and escalation read it through `clock()`. Without a default active calendar (or with an
 * always-open one) every consumer falls back to calendar time, which is exactly the Phase 6A behaviour.
 * The default schedule is cached for 30 s and dropped on every write (single node; see docs for multi-node).
 */
@Injectable()
export class CalendarService {
  private cache: {
    at: number;
    schedule: WorkingSchedule | null;
    clock: BusinessClock;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  invalidate() {
    this.cache = null;
  }

  private async load() {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const row = await this.prisma.workingCalendar.findFirst({
      where: { isDefault: true, active: true },
      include: { days: true, exceptions: true },
    });
    const schedule = row ? toSchedule(row) : null;
    const clock =
      !schedule || isAlwaysOpen(schedule)
        ? CALENDAR_TIME
        : workingClock(schedule);
    this.cache = { at: Date.now(), schedule, clock };
    return this.cache;
  }

  async schedule(): Promise<WorkingSchedule | null> {
    return (await this.load()).schedule;
  }

  async clock(): Promise<BusinessClock> {
    return (await this.load()).clock;
  }

  // ───────────────────────── configuration ─────────────────────────

  private async mustFind(
    client: Prisma.TransactionClient | PrismaService,
    id: string,
  ): Promise<Full> {
    const c = await client.workingCalendar.findUnique({
      where: { id },
      include: { days: true, exceptions: true },
    });
    if (!c) throw new NotFoundException('Working calendar not found');
    return c;
  }

  async list() {
    const rows = await this.prisma.workingCalendar.findMany({
      include: { days: true, exceptions: true },
      orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    });
    return rows.map(view);
  }

  async get(id: string) {
    return view(await this.mustFind(this.prisma, id));
  }

  async create(
    dto: CreateWorkingCalendarDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    if (!validZone(dto.timezone))
      throw new BadRequestException('timezone must be a valid IANA time zone');
    const days = dto.days ?? WORKWEEK;
    const created = await this.prisma.$transaction(async (tx) => {
      if (await tx.workingCalendar.findUnique({ where: { code: dto.code } }))
        throw new ConflictException(`Calendar ${dto.code} already exists`);
      this.assertUniqueWeekdays(days);
      const hasDefault = await tx.workingCalendar.count({
        where: { isDefault: true },
      });
      const c = await tx.workingCalendar.create({
        data: {
          code: dto.code,
          name: dto.name,
          timezone: dto.timezone,
          isDefault: hasDefault === 0,
          days: {
            create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
              const given = days.find((d) => d.weekday === weekday);
              const h = given ? hoursOf(given) : null;
              return {
                weekday,
                isWorkingDay: !!h,
                startMinute: h?.start ?? null,
                endMinute: h?.end ?? null,
              };
            }),
          },
        },
        include: { days: true, exceptions: true },
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.WORKING_CALENDAR_CREATED,
        c.id,
        { code: c.code, timezone: c.timezone },
      );
      return c;
    });
    this.invalidate();
    return view(created);
  }

  private assertUniqueWeekdays(days: WorkingDayDto[]) {
    if (new Set(days.map((d) => d.weekday)).size !== days.length)
      throw new BadRequestException('Each weekday may appear once');
  }

  async update(
    id: string,
    dto: UpdateWorkingCalendarDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const out = await this.prisma.$transaction(async (tx) => {
      const cur = await this.mustFind(tx, id);
      if (dto.timezone !== undefined && !validZone(dto.timezone))
        throw new BadRequestException(
          'timezone must be a valid IANA time zone',
        );
      if (dto.active === false && cur.isDefault)
        throw new ConflictException(
          'The default calendar cannot be deactivated; make another one the default first',
        );
      const data: Prisma.WorkingCalendarUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.timezone !== undefined) data.timezone = dto.timezone;
      if (dto.active !== undefined) data.active = dto.active;
      if (Object.keys(data).length === 0)
        throw new BadRequestException('Nothing to update');
      await tx.workingCalendar.update({ where: { id }, data });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.WORKING_CALENDAR_UPDATED,
        id,
        { changes: dto },
      );
      return this.mustFind(tx, id);
    });
    this.invalidate();
    return view(out);
  }

  async makeDefault(id: string, actor: AuthUser, meta: RequestMeta) {
    const out = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('working-calendar-default'))`;
      const cur = await this.mustFind(tx, id);
      if (!cur.active)
        throw new ConflictException(
          'Only an active calendar can be the default',
        );
      await tx.workingCalendar.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      await tx.workingCalendar.update({
        where: { id },
        data: { isDefault: true },
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.WORKING_CALENDAR_DEFAULT_CHANGED,
        id,
        { code: cur.code },
      );
      return this.mustFind(tx, id);
    });
    this.invalidate();
    return view(out);
  }

  async setWeekly(
    id: string,
    days: WorkingDayDto[],
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    this.assertUniqueWeekdays(days);
    const out = await this.prisma.$transaction(async (tx) => {
      await this.mustFind(tx, id);
      for (const d of days) {
        const h = hoursOf(d);
        await tx.workingCalendarDay.upsert({
          where: { calendarId_weekday: { calendarId: id, weekday: d.weekday } },
          create: {
            calendarId: id,
            weekday: d.weekday,
            isWorkingDay: !!h,
            startMinute: h?.start ?? null,
            endMinute: h?.end ?? null,
          },
          update: {
            isWorkingDay: !!h,
            startMinute: h?.start ?? null,
            endMinute: h?.end ?? null,
          },
        });
      }
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.WORKING_CALENDAR_UPDATED,
        id,
        { weekly: days },
      );
      return this.mustFind(tx, id);
    });
    this.invalidate();
    return view(out);
  }

  async setException(
    id: string,
    dto: SetCalendarExceptionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const h = hoursOf(dto);
    const out = await this.prisma.$transaction(async (tx) => {
      await this.mustFind(tx, id);
      await tx.workingCalendarException.upsert({
        where: { calendarId_date: { calendarId: id, date: dateOf(dto.date) } },
        create: {
          calendarId: id,
          date: dateOf(dto.date),
          isWorkingDay: !!h,
          startMinute: h?.start ?? null,
          endMinute: h?.end ?? null,
          reason: dto.reason,
        },
        update: {
          isWorkingDay: !!h,
          startMinute: h?.start ?? null,
          endMinute: h?.end ?? null,
          reason: dto.reason ?? null,
        },
      });
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.WORKING_CALENDAR_EXCEPTION_SET,
        id,
        {
          date: dto.date,
          isWorkingDay: dto.isWorkingDay,
          startTime: dto.startTime,
          endTime: dto.endTime,
          reason: dto.reason,
        },
      );
      return this.mustFind(tx, id);
    });
    this.invalidate();
    return view(out);
  }

  async removeException(
    id: string,
    date: string,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(dateOf(date).getTime())
    )
      throw new BadRequestException('date must be YYYY-MM-DD');
    const out = await this.prisma.$transaction(async (tx) => {
      await this.mustFind(tx, id);
      const { count } = await tx.workingCalendarException.deleteMany({
        where: { calendarId: id, date: dateOf(date) },
      });
      if (count === 0) throw new NotFoundException('No exception on that date');
      await this.record(
        tx,
        actor,
        meta,
        AuditAction.WORKING_CALENDAR_EXCEPTION_REMOVED,
        id,
        { date },
      );
      return this.mustFind(tx, id);
    });
    this.invalidate();
    return view(out);
  }

  /** What each day of a range looks like (hours in the calendar's zone), exceptions applied. */
  async preview(id: string, q: CalendarPreviewQueryDto) {
    const c = await this.mustFind(this.prisma, id);
    const sch = toSchedule(c);
    const from = q.from ?? businessDayKey(new Date(), c.timezone);
    const to = q.to ?? addDays(from, 13);
    if (to < from) throw new BadRequestException('to must not be before from');
    const keys = dayKeys(from, to);
    if (keys.length > 62)
      throw new BadRequestException('The preview is limited to 62 days');
    return {
      calendarId: id,
      timezone: c.timezone,
      days: keys.map((date) => {
        const h = hoursFor(sch, date);
        const exception = sch.exceptions.has(date);
        return {
          date,
          isWorkingDay: !!h,
          startTime: h ? formatHHMM(h.start) : null,
          endTime: h ? formatHHMM(h.end) : null,
          workingMinutes: h ? h.end - h.start : 0,
          source: exception ? 'EXCEPTION' : 'WEEKLY',
        };
      }),
    };
  }

  private record(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    meta: RequestMeta,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        actorUserId: actor.id,
        action,
        entityType: 'WorkingCalendar',
        entityId: id,
        metadata,
        meta,
      },
      tx,
    );
  }
}
