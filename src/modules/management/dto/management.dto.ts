import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  CapacityUnit,
  DepartmentType,
  JobPriority,
  SlaTargetType,
} from '../../../generated/prisma/client.js';
import { ATTENTION_TYPES } from '../pure/attention.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
const csv = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  );

export class RangeQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Start. A plain date means the start of that business day (BUSINESS_TIMEZONE); a date-time is taken as UTC/offset. Default: `to` minus the default range',
  })
  @IsOptional()
  @IsString()
  @Matches(DATE_OR_DATETIME, {
    message: 'from must be an ISO date or date-time',
  })
  from?: string;
  @ApiPropertyOptional({
    example: '2026-10-31',
    description:
      'End. A plain date includes that whole business day. Default: now',
  })
  @IsOptional()
  @IsString()
  @Matches(DATE_OR_DATETIME, { message: 'to must be an ISO date or date-time' })
  to?: string;
}

export class UtilizationQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'First day (business day). Default: today',
  })
  @IsOptional()
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from?: string;
  @ApiPropertyOptional({
    example: '2026-10-27',
    description: 'Last day, inclusive. Default: from + 6 days; at most 31 days',
  })
  @IsOptional()
  @Matches(DAY, { message: 'to must be YYYY-MM-DD' })
  to?: string;
  @ApiPropertyOptional({ enum: DepartmentType })
  @IsOptional()
  @IsEnum(DepartmentType)
  department?: DepartmentType;
}

export class AttentionQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
  @ApiPropertyOptional({
    enum: ATTENTION_TYPES,
    isArray: true,
    description: 'Comma separated',
  })
  @IsOptional()
  @csv()
  @IsEnum(ATTENTION_TYPES, { each: true })
  type?: (typeof ATTENTION_TYPES)[number][];
  @ApiPropertyOptional({
    enum: ['INFO', 'WARNING', 'CRITICAL'],
    description: 'Minimum severity',
  })
  @IsOptional()
  @IsEnum(['INFO', 'WARNING', 'CRITICAL'])
  minSeverity?: 'INFO' | 'WARNING' | 'CRITICAL';
}

export class StaffWorkloadQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @Matches(DATE_OR_DATETIME)
  from?: string;
  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @Matches(DATE_OR_DATETIME)
  to?: string;
  @ApiPropertyOptional({ enum: DepartmentType })
  @IsOptional()
  @IsEnum(DepartmentType)
  department?: DepartmentType;
}

export class ManagementBoardQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'SEWING' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  stageCode?: string;
  @ApiPropertyOptional({ enum: DepartmentType })
  @IsOptional()
  @IsEnum(DepartmentType)
  department?: DepartmentType;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Jobs with a stage assigned to this user',
  })
  @IsOptional()
  @IsUUID()
  assignedUserId?: string;
  @ApiPropertyOptional({ enum: JobPriority })
  @IsOptional()
  @IsEnum(JobPriority)
  priority?: JobPriority;
  @ApiPropertyOptional({
    description: 'Jobs that are blocked (status or open blocker)',
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  blocked?: boolean;
  @ApiPropertyOptional({
    description: 'Jobs with at least one delay reason (see delay rules)',
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  delayed?: boolean;
  @ApiPropertyOptional({ enum: ['SAMPLE', 'BULK'] })
  @IsOptional()
  @IsEnum(['SAMPLE', 'BULK'])
  kind?: 'SAMPLE' | 'BULK';
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;
}

// ───────────────────────── SLA rules ─────────────────────────

export class CreateSlaRuleDto {
  @ApiProperty({ example: 'STAGE_DEFAULT' })
  @Trim()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9_]{2,60}$/, { message: 'code must be UPPER_SNAKE_CASE' })
  code!: string;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
  @ApiProperty({ enum: SlaTargetType })
  @IsEnum(SlaTargetType)
  targetType!: SlaTargetType;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'STAGE rules only; omit for the default stage rule',
  })
  @IsOptional()
  @IsUUID()
  stageDefinitionId?: string;
  @ApiProperty({ example: 480, description: 'Allowed minutes (1 … 525600)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(525_600)
  thresholdMinutes!: number;
  @ApiPropertyOptional({
    example: 60,
    description:
      'Warning window before the deadline; default 20% of the threshold',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  warningBeforeMinutes?: number;
  @ApiPropertyOptional({
    example: { URGENT: 0.5, HIGH: 0.75 },
    description: 'Threshold multiplier per priority (0.1 … 10)',
  })
  @IsOptional()
  @IsObject()
  priorityMultipliers?: Record<string, number>;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateSlaRuleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(525_600)
  thresholdMinutes?: number;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  warningBeforeMinutes?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsObject()
  priorityMultipliers?: Record<string, number> | null;
  @ApiPropertyOptional({
    description: 'Re-activate (a deactivated rule is never deleted)',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ───────────────────────── capacity ─────────────────────────

const DAY_MSG = { message: 'must be YYYY-MM-DD' };

export class CreateDepartmentCapacityDto {
  @ApiProperty({ enum: DepartmentType })
  @IsEnum(DepartmentType)
  departmentType!: DepartmentType;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Narrow the capacity to one stage definition',
  })
  @IsOptional()
  @IsUUID()
  stageDefinitionId?: string;
  @ApiProperty({ enum: CapacityUnit })
  @IsEnum(CapacityUnit)
  capacityUnit!: CapacityUnit;
  @ApiProperty({
    example: 200,
    description: 'Units per day (pieces, jobs or minutes)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  dailyCapacity!: number;
  @ApiPropertyOptional({ example: 480 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  workingMinutesPerDay?: number;
  @ApiProperty({ example: '2026-10-01' })
  @Matches(DAY, DAY_MSG)
  effectiveFrom!: string;
  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Inclusive; omit for open-ended',
  })
  @IsOptional()
  @Matches(DAY, DAY_MSG)
  effectiveTo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateDepartmentCapacityDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  dailyCapacity?: number;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  workingMinutesPerDay?: number | null;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DAY, DAY_MSG)
  effectiveFrom?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(DAY, DAY_MSG)
  effectiveTo?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateStaffCapacityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  stageDefinitionId?: string;
  @ApiProperty({ example: 420 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  workingMinutesPerDay!: number;
  @ApiProperty({ example: '2026-10-01' })
  @Matches(DAY, DAY_MSG)
  effectiveFrom!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DAY, DAY_MSG)
  effectiveTo?: string;
}

export class UpdateStaffCapacityDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  workingMinutesPerDay?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DAY, DAY_MSG)
  effectiveFrom?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(DAY, DAY_MSG)
  effectiveTo?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
