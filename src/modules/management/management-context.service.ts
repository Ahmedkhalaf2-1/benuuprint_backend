import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import {
  RangeError_,
  businessDayKey,
  resolveRange,
  startOfBusinessDay,
  startOfBusinessWeek,
  type ResolvedRange,
} from './pure/business-time.js';

/**
 * Shared settings and the clock of every management query. Analytics never call `new Date()`
 * themselves, so a test can freeze time and the business time zone is applied in one place.
 */
@Injectable()
export class ManagementContext {
  readonly cfg: AppConfig['management'];
  private frozen: Date | null = null;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<AppConfig>('app').management;
  }

  get timezone(): string {
    return this.cfg.timezone;
  }

  now(): Date {
    return this.frozen ? new Date(this.frozen) : new Date();
  }

  /** Test hook: pin "now". Refused in production. */
  freeze(at: Date | null): void {
    if (process.env.NODE_ENV === 'production')
      throw new Error('The management clock cannot be frozen in production');
    this.frozen = at ? new Date(at) : null;
  }

  todayKey(now = this.now()): string {
    return businessDayKey(now, this.timezone);
  }
  todayStart(now = this.now()): Date {
    return startOfBusinessDay(now, this.timezone);
  }
  weekStart(now = this.now()): Date {
    return startOfBusinessWeek(now, this.timezone);
  }

  range(input: { from?: string; to?: string }): ResolvedRange {
    try {
      return resolveRange(input, this.now(), this.timezone, {
        defaultDays: this.cfg.defaultRangeDays,
        maxDays: this.cfg.maxRangeDays,
      });
    } catch (e) {
      if (e instanceof RangeError_) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
