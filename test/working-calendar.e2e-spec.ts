import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { ManagementContext } from '../src/modules/management/management-context.service.js';
import {
  auditActions,
  createTestApp,
  createUserAndLogin,
} from './support/app.js';
import {
  api,
  lookupRefs,
  makeActors,
  type Actors,
  type Api,
  type Refs,
} from './support/factory.js';
import { currentStage, makeFloor, type Floor } from './support/floor.js';
import {
  approvedReferenceSample,
  readyOrder,
  type ApprovedSample,
} from './support/orders.js';

const week = (days: number[], start = '09:00', end = '17:00') =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    isWorkingDay: days.includes(weekday),
    startTime: days.includes(weekday) ? start : undefined,
    endTime: days.includes(weekday) ? end : undefined,
  }));

describe('Working calendar (Phase 6B, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ctx: ManagementContext;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let admin: Api;
  let originalDefaultId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ctx = app.get(ManagementContext);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    admin = api(
      app,
      (await createUserAndLogin(app, { roleCodes: ['ADMIN'] })).accessToken,
    );
    originalDefaultId = (
      await prisma.workingCalendar.findFirstOrThrow({
        where: { isDefault: true },
      })
    ).id;
  });
  afterEach(async () => {
    ctx.freeze(null);
    // whatever a test did, the shared default goes back to the seeded 24/7 calendar
    await admin.post(
      `/admin/working-calendars/${originalDefaultId}/make-default`,
    );
  });
  afterAll(() => app.close());

  const make = async (
    code: string,
    timezone = 'Africa/Cairo',
    days = week([0, 1, 2, 3, 4]),
  ) =>
    (
      await admin
        .post('/admin/working-calendars', { code, name: code, timezone, days })
        .expect(201)
    ).body;
  const code = () =>
    `T_CAL_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  describe('configuration', () => {
    it('is seeded with an always-open default so nothing changes until real hours are entered', async () => {
      const list = (await admin.get('/admin/working-calendars').expect(200))
        .body;
      const def = list[0];
      expect(def).toMatchObject({
        code: 'FACTORY_DEFAULT',
        isDefault: true,
        active: true,
        timezone: 'Asia/Kolkata',
      });
      expect(def.days).toHaveLength(7);
      expect(
        def.days.every(
          (d: { isWorkingDay: boolean; startTime: string; endTime: string }) =>
            d.isWorkingDay && d.startTime === '00:00' && d.endTime === '24:00',
        ),
      ).toBe(true);
      expect(
        list.filter((c: { isDefault: boolean }) => c.isDefault),
      ).toHaveLength(1);
    });

    it('creates calendars with weekly hours, in an IANA zone, and validates everything', async () => {
      const c = await make(code());
      expect(c).toMatchObject({
        isDefault: false,
        active: true,
        timezone: 'Africa/Cairo',
      });
      expect(
        c.days
          .filter((d: { isWorkingDay: boolean }) => d.isWorkingDay)
          .map((d: { weekday: number }) => d.weekday),
      ).toEqual([0, 1, 2, 3, 4]);
      expect(c.days[5]).toMatchObject({
        weekday: 5,
        isWorkingDay: false,
        startTime: null,
        endTime: null,
      });
      const post = (body: object) =>
        admin.post('/admin/working-calendars', body);
      await post({ code: c.code, name: 'Duplicate', timezone: 'UTC' }).expect(
        409,
      );
      await post({
        code: code(),
        name: 'Valid name',
        timezone: 'Mars/Olympus',
      }).expect(400);
      await post({
        code: 'bad code',
        name: 'Valid name',
        timezone: 'UTC',
      }).expect(400);
      await post({
        code: code(),
        name: 'Valid name',
        timezone: 'UTC',
        days: [
          {
            weekday: 1,
            isWorkingDay: true,
            startTime: '17:00',
            endTime: '09:00',
          },
        ],
      }).expect(400);
      await post({
        code: code(),
        name: 'Valid name',
        timezone: 'UTC',
        days: [{ weekday: 1, isWorkingDay: true }],
      }).expect(400);
      await post({
        code: code(),
        name: 'Valid name',
        timezone: 'UTC',
        days: [
          {
            weekday: 1,
            isWorkingDay: false,
            startTime: '09:00',
            endTime: '17:00',
          },
        ],
      }).expect(400);
      await post({
        code: code(),
        name: 'Valid name',
        timezone: 'UTC',
        days: [
          { weekday: 1, isWorkingDay: false },
          { weekday: 1, isWorkingDay: false },
        ],
      }).expect(400);
      await post({
        code: code(),
        name: 'Valid name',
        timezone: 'UTC',
        days: [{ weekday: 9, isWorkingDay: false }],
      }).expect(400);
      const ok = await post({
        code: code(),
        name: 'Valid name',
        timezone: 'UTC',
        days: [
          {
            weekday: 2,
            isWorkingDay: true,
            startTime: '00:00',
            endTime: '24:00',
          },
        ],
      });
      expect(ok.status).toBe(201);
      expect(await auditActions(app, c.id)).toEqual([
        'working_calendar.created',
      ]);
    });

    it('edits weekly hours, holidays, exceptional working days and shortened days', async () => {
      const c = await make(code());
      const w = (
        await admin
          .put(`/admin/working-calendars/${c.id}/weekly`, {
            days: [
              {
                weekday: 5,
                isWorkingDay: true,
                startTime: '10:00',
                endTime: '14:00',
              },
              {
                weekday: 0,
                isWorkingDay: true,
                startTime: '08:00',
                endTime: '16:00',
              },
            ],
          })
          .expect(200)
      ).body;
      expect(
        w.days.find((d: { weekday: number }) => d.weekday === 5),
      ).toMatchObject({
        isWorkingDay: true,
        startTime: '10:00',
        endTime: '14:00',
      });
      expect(
        w.days.find((d: { weekday: number }) => d.weekday === 0),
      ).toMatchObject({ startTime: '08:00', endTime: '16:00' });
      await admin
        .put(`/admin/working-calendars/${c.id}/weekly`, { days: [] })
        .expect(400);

      const put = (body: object) =>
        admin.put(`/admin/working-calendars/${c.id}/exceptions`, body);
      await put({
        date: '2031-01-06',
        isWorkingDay: false,
        reason: 'Holiday',
      }).expect(200); // Monday
      await put({
        date: '2031-01-11',
        isWorkingDay: true,
        startTime: '10:00',
        endTime: '14:00',
        reason: 'Make-up Saturday',
      }).expect(200);
      const r = (
        await put({
          date: '2031-01-07',
          isWorkingDay: true,
          startTime: '09:00',
          endTime: '12:00',
          reason: 'Short day',
        }).expect(200)
      ).body;
      expect(r.exceptions.map((e: { date: string }) => e.date)).toEqual([
        '2031-01-06',
        '2031-01-07',
        '2031-01-11',
      ]);
      await put({
        date: '2031-01-07',
        isWorkingDay: true,
        startTime: '09:00',
        endTime: '13:00',
      }).expect(200); // update in place
      await put({ date: '2031-1-7', isWorkingDay: false }).expect(400);
      await put({ date: '2031-01-08', isWorkingDay: true }).expect(400);
      await admin
        .del(`/admin/working-calendars/${c.id}/exceptions/2031-01-07`)
        .expect(200);
      await admin
        .del(`/admin/working-calendars/${c.id}/exceptions/2031-01-07`)
        .expect(404);
      await admin
        .del(`/admin/working-calendars/${c.id}/exceptions/garbage`)
        .expect(400);

      const preview = (
        await admin
          .get(
            `/admin/working-calendars/${c.id}/preview?from=2031-01-05&to=2031-01-11`,
          )
          .expect(200)
      ).body;
      expect(preview.timezone).toBe('Africa/Cairo');
      expect(
        preview.days.map(
          (d: {
            date: string;
            isWorkingDay: boolean;
            workingMinutes: number;
            source: string;
          }) => [d.date, d.workingMinutes, d.source],
        ),
      ).toEqual([
        ['2031-01-05', 480, 'WEEKLY'], // Sunday
        ['2031-01-06', 0, 'EXCEPTION'], // holiday
        ['2031-01-07', 480, 'WEEKLY'], // short day removed again
        ['2031-01-08', 480, 'WEEKLY'],
        ['2031-01-09', 480, 'WEEKLY'],
        ['2031-01-10', 240, 'WEEKLY'], // Friday 10–14 weekly hours
        ['2031-01-11', 240, 'EXCEPTION'], // exceptional Saturday
      ]);
      await admin
        .get(
          `/admin/working-calendars/${c.id}/preview?from=2031-01-01&to=2031-06-01`,
        )
        .expect(400);
      await admin
        .get(
          `/admin/working-calendars/${c.id}/preview?from=2031-01-05&to=2031-01-01`,
        )
        .expect(400);
      expect(await auditActions(app, c.id)).toEqual(
        expect.arrayContaining([
          'working_calendar.created',
          'working_calendar.updated',
          'working_calendar.exception_set',
          'working_calendar.exception_removed',
        ]),
      );
    });

    it('has exactly one default; the default cannot be deactivated and only active calendars can be default', async () => {
      const c = await make(code());
      const d = (
        await admin
          .post(`/admin/working-calendars/${c.id}/make-default`)
          .expect(200)
      ).body;
      expect(d.isDefault).toBe(true);
      expect(
        await prisma.workingCalendar.count({ where: { isDefault: true } }),
      ).toBe(1);
      expect(
        (await admin.get('/admin/working-calendars').expect(200)).body[0].id,
      ).toBe(c.id);
      await admin
        .put(`/admin/working-calendars/${c.id}`, { active: false })
        .expect(409);
      await admin
        .post(`/admin/working-calendars/${originalDefaultId}/make-default`)
        .expect(200);
      await admin
        .put(`/admin/working-calendars/${c.id}`, {
          active: false,
          name: 'Retired',
        })
        .expect(200);
      await admin
        .post(`/admin/working-calendars/${c.id}/make-default`)
        .expect(409);
      await admin.put(`/admin/working-calendars/${c.id}`, {}).expect(400);
      await admin
        .put(`/admin/working-calendars/${c.id}`, { timezone: 'Nope/Zone' })
        .expect(400);
      await admin
        .get('/admin/working-calendars/5c7e1b88-0000-4000-8000-000000000000')
        .expect(404);
      await expect(
        prisma.workingCalendar.update({
          where: { id: c.id },
          data: { isDefault: true },
        }),
      ).rejects.toThrow(); // inactive default is refused by the database
      expect(await auditActions(app, c.id)).toContain(
        'working_calendar.default_changed',
      );
    });

    it('is protected by permission', async () => {
      await floor.sewing.api.get('/admin/working-calendars').expect(403);
      await a.finance.get('/admin/working-calendars').expect(403);
      await a.sales.get('/admin/working-calendars').expect(200); // working_calendar.read
      await a.sales
        .post('/admin/working-calendars', {
          code: code(),
          name: 'Valid name',
          timezone: 'UTC',
        })
        .expect(403);
      await a.sales
        .post(`/admin/working-calendars/${originalDefaultId}/make-default`)
        .expect(403);
    });
  });

  describe('SLA and ETA use working time', () => {
    // Sun–Thu 09:00–17:00 Cairo; January is UTC+2. 2031-01-09 is a Thursday.
    const newJob = async () => {
      const order = await readyOrder(a.admin, s, { priority: 'NORMAL' });
      const job = (
        await a.admin
          .post(`/admin/orders/${order.id}/create-factory-job`)
          .expect(201)
      ).body as { id: string };
      return job;
    };
    const stageSla = async (jobId: string, stageId: string) =>
      (
        await a.sales.get(`/admin/management/jobs/${jobId}/delay`).expect(200)
      ).body.stages.find((x: { stageId: string }) => x.stageId === stageId).sla;

    it('an SLA deadline skips the weekend and remaining time is counted in working minutes', async () => {
      const code1 = `T_SLA_${Date.now()}`;
      const def = await prisma.productionStageDefinition.findUniqueOrThrow({
        where: { code: 'FABRIC_PREPARATION' },
      });
      const rule = (
        await a.admin
          .post('/admin/management/sla-rules', {
            code: code1,
            name: 'Fabric 2h',
            targetType: 'STAGE',
            stageDefinitionId: def.id,
            thresholdMinutes: 120,
            warningBeforeMinutes: 30,
          })
          .expect(201)
      ).body;
      const cal = await make(code());
      try {
        const job = await newJob();
        const st = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
        await prisma.jobStage.update({
          where: { id: st.id },
          data: { readyAt: new Date('2031-01-09T14:00:00Z') },
        }); // Thursday 16:00 local
        ctx.freeze(new Date('2031-01-10T10:00:00Z')); // Friday 12:00 local: closed

        // calendar time (seeded default): 2 h after readyAt, long gone
        let sla = await stageSla(job.id, st.id);
        expect(sla).toMatchObject({
          deadlineSource: 'RULE',
          state: 'BREACHED',
        });
        expect(new Date(sla.deadline).toISOString()).toBe(
          '2031-01-09T16:00:00.000Z',
        );

        await admin
          .post(`/admin/working-calendars/${cal.id}/make-default`)
          .expect(200);
        sla = await stageSla(job.id, st.id);
        // 60 min left on Thursday + 60 on Sunday → due Sunday 10:00 local, 60 working minutes still remain on Friday noon
        expect(new Date(sla.deadline).toISOString()).toBe(
          '2031-01-12T08:00:00.000Z',
        );
        expect(sla).toMatchObject({
          state: 'ON_TRACK',
          remainingMinutes: 60,
          elapsedMinutes: 60,
          breached: false,
        });

        ctx.freeze(new Date('2031-01-12T07:45:00Z')); // Sunday 09:45 local: inside the 30 min warning window
        expect((await stageSla(job.id, st.id)).state).toBe('WARNING');
        ctx.freeze(new Date('2031-01-12T09:00:00Z')); // Sunday 11:00 local: 60 working minutes late
        expect(await stageSla(job.id, st.id)).toMatchObject({
          state: 'BREACHED',
          breachMinutes: 60,
        });
      } finally {
        await a.admin
          .post(`/admin/management/sla-rules/${rule.id}/deactivate`)
          .expect(200);
      }
    }, 60_000);

    it('an ETA is counted in working minutes and starts at the next working moment', async () => {
      const cal = await make(code());
      const job = await newJob();
      await prisma.jobStage.updateMany({
        where: { jobId: job.id },
        data: { expectedDurationMinutes: 240 },
      });
      const prevMin = ctx.cfg.etaMinSamples;
      ctx.cfg.etaMinSamples = 1_000_000;
      try {
        ctx.freeze(new Date('2031-01-10T10:00:00Z')); // Friday noon local
        const calendarEta = (
          await a.sales.get(`/admin/management/jobs/${job.id}/eta`).expect(200)
        ).body;
        await admin
          .post(`/admin/working-calendars/${cal.id}/make-default`)
          .expect(200);
        const workingEta = (
          await a.sales.get(`/admin/management/jobs/${job.id}/eta`).expect(200)
        ).body;
        const first = (r: typeof calendarEta) =>
          r.stages.find(
            (x: { stageCode: string }) => x.stageCode === 'FABRIC_PREPARATION',
          );
        expect(
          new Date(first(calendarEta).estimatedStartAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date('2031-01-10T10:00:00Z').getTime());
        // with a working calendar nothing starts before Sunday 09:00 local (07:00Z)
        expect(
          new Date(first(workingEta).estimatedStartAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date('2031-01-12T07:00:00Z').getTime());
        expect(
          new Date(workingEta.estimatedCompletionAt).getTime(),
        ).toBeGreaterThan(
          new Date(calendarEta.estimatedCompletionAt).getTime(),
        );
        // 10 stages × 240 working minutes = 5 working days at 480 min/day = at least 5 working days after Sunday 09:00
        const work =
          new Date(workingEta.estimatedCompletionAt).getTime() -
          new Date('2031-01-12T07:00:00Z').getTime();
        expect(work).toBeGreaterThanOrEqual(4 * 86_400_000);
        expect(workingEta.basis.join('|')).toMatch(/Working time/);
        expect(calendarEta.basis.join('|')).toMatch(/Calendar time/);
        // every stage ends on a working day (Sun–Thu in Cairo, UTC+2 in January), never on a Friday or Saturday
        for (const st of workingEta.stages) {
          const local = new Date(
            new Date(st.estimatedEndAt).getTime() + 2 * 3_600_000,
          );
          expect([0, 1, 2, 3, 4]).toContain(local.getUTCDay());
        }
      } finally {
        ctx.cfg.etaMinSamples = prevMin;
      }
    }, 60_000);
  });
});
