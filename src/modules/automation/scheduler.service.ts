import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ManagementContext } from '../management/management-context.service.js';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service.js';
import { OutboxProcessorService } from '../notifications/outbox-processor.service.js';
import { AlertsService } from './alerts.service.js';

export const SCHEDULER_TASKS = ['outbox', 'dispatch', 'alerts'] as const;
export type SchedulerTask = (typeof SCHEDULER_TASKS)[number];

/**
 * In-process scheduler for the single-node deployment: three timers (outbox draining, notification delivery,
 * alert evaluation) with single-flight per task and a heartbeat row per task for observability.
 *
 * Why this is enough: every task is idempotent and safe to run concurrently (rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, events and notifications carry deduplication keys, alerts have a unique open
 * fingerprint), so running the API on several nodes would not duplicate work; at worst two nodes do a task
 * at the same moment. Multi-node path: keep this as is, or move the same three methods behind a job queue.
 */
@Injectable()
export class SchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SchedulerService.name);
  private readonly cfg: AppConfig['scheduler'];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<SchedulerTask>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxProcessorService,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly alerts: AlertsService,
    private readonly ctx: ManagementContext,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app').scheduler;
  }

  onApplicationBootstrap() {
    if (!this.cfg.enabled) {
      this.logger.log('Scheduler disabled (SCHEDULER_ENABLED=false)');
      return;
    }
    const every = (task: SchedulerTask, seconds: number) =>
      this.timers.push(
        setInterval(
          () =>
            void this.run(task).catch((e: unknown) =>
              this.logger.error(String(e)),
            ),
          seconds * 1000,
        ).unref(),
      );
    every('outbox', this.cfg.outboxIntervalSeconds);
    every('dispatch', this.cfg.dispatchIntervalSeconds);
    every('alerts', this.cfg.alertsIntervalSeconds);
    this.logger.log(
      `Scheduler started: outbox ${this.cfg.outboxIntervalSeconds}s, dispatch ${this.cfg.dispatchIntervalSeconds}s, alerts ${this.cfg.alertsIntervalSeconds}s`,
    );
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /** Runs one task now (also used by the manual "run now" endpoint and by tests). Skips when it is already running. */
  async run(task: SchedulerTask): Promise<Record<string, unknown>> {
    if (this.running.has(task))
      return { skipped: true, reason: 'already running' };
    this.running.add(task);
    const startedAt = this.ctx.now();
    let status = 'OK';
    let error: string | null = null;
    let details: Record<string, unknown> = {};
    try {
      if (task === 'outbox') {
        // drain in bounded rounds so a backlog clears without starving the other tasks
        const total = {
          claimed: 0,
          processed: 0,
          retried: 0,
          failed: 0,
          notifications: 0,
        };
        for (let i = 0; i < 5; i++) {
          const r = await this.outbox.processBatch();
          for (const k of Object.keys(total) as (keyof typeof total)[])
            total[k] += r[k];
          if (r.claimed < 1) break;
        }
        details = total;
      } else if (task === 'dispatch')
        details = { ...(await this.dispatcher.dispatchDue()) };
      else details = { ...(await this.alerts.evaluate()) };
    } catch (e) {
      status = 'FAILED';
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      this.logger.error(`Scheduler task ${task} failed: ${error}`);
    } finally {
      this.running.delete(task);
    }
    await this.record(task, status, startedAt, details, error).catch(
      (e: unknown) => this.logger.error(`Could not record run: ${String(e)}`),
    );
    return { status, ...details, ...(error && { error }) };
  }

  private idle(details: Record<string, unknown>) {
    return Object.values(details).every(
      (v) => v === 0 || (Array.isArray(v) && v.length === 0) || v === false,
    );
  }

  /** One heartbeat row per task (always updated) plus a history row for runs that did something or failed. */
  private async record(
    task: SchedulerTask,
    status: string,
    startedAt: Date,
    details: Record<string, unknown>,
    error: string | null,
  ) {
    const finishedAt = this.ctx.now();
    const payload = details as Prisma.InputJsonValue;
    const beat = await this.prisma.schedulerRun.findFirst({ where: { task } });
    if (beat)
      await this.prisma.schedulerRun.update({
        where: { id: beat.id },
        data: { status, startedAt, finishedAt, details: payload, error },
      });
    else
      await this.prisma.schedulerRun.create({
        data: { task, status, startedAt, finishedAt, details: payload, error },
      });
    if (status !== 'OK' || !this.idle(details))
      await this.prisma.schedulerRun.create({
        data: {
          task: `${task}:run`,
          status,
          startedAt,
          finishedAt,
          details: payload,
          error,
        },
      });
    // keep history bounded
    await this.prisma.schedulerRun.deleteMany({
      where: {
        task: { endsWith: ':run' },
        startedAt: { lt: new Date(finishedAt.getTime() - 14 * 86_400_000) },
      },
    });
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      intervals: {
        outbox: this.cfg.outboxIntervalSeconds,
        dispatch: this.cfg.dispatchIntervalSeconds,
        alerts: this.cfg.alertsIntervalSeconds,
      },
      runningNow: [...this.running],
    };
  }
}
