import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import {
  AlertStatus,
  AutomationAudience,
  EscalationRecipientKind,
  NotificationChannel,
  NotificationSeverity,
} from '../../../generated/prisma/client.js';
import { ATTENTION_TYPES } from '../../management/pure/attention.js';
import { EVENT_TYPES } from '../../notifications/events.js';

const CODE = /^[A-Z0-9_]{2,60}$/;

export class CreateAutomationRuleDto {
  @ApiProperty({ example: 'QC_FAILED_ADMIN' })
  @Trim()
  @Matches(CODE, { message: 'code must be UPPER_SNAKE_CASE' })
  code!: string;
  @ApiProperty({ enum: EVENT_TYPES })
  @IsIn([...EVENT_TYPES])
  eventType!: string;
  @ApiPropertyOptional({
    enum: ATTENTION_TYPES,
    description: 'ALERT_* events only',
  })
  @IsOptional()
  @IsIn([...ATTENTION_TYPES])
  alertType?: string;
  @ApiPropertyOptional({
    enum: NotificationSeverity,
    description: 'ALERT_* events only: minimum alert severity',
  })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  minSeverity?: NotificationSeverity;
  @ApiProperty({ enum: AutomationAudience })
  @IsEnum(AutomationAudience)
  audience!: AutomationAudience;
  @ApiPropertyOptional({
    description: 'Role code (ROLE) or permission code (PERMISSION)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  audienceValue?: string;
  @ApiProperty({ enum: NotificationChannel, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsEnum(NotificationChannel, { each: true })
  channels!: NotificationChannel[];
  @ApiProperty({ example: 'QC_FAILED' })
  @IsString()
  @MaxLength(60)
  templateCode!: string;
  @ApiPropertyOptional({ enum: NotificationSeverity })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  severity?: NotificationSeverity;
  @ApiPropertyOptional({
    description: 'Critical rules ignore user preferences and quiet hours',
  })
  @IsOptional()
  @IsBoolean()
  critical?: boolean;
}

export class UpdateAutomationRuleDto {
  @ApiPropertyOptional({ enum: NotificationChannel, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsEnum(NotificationChannel, { each: true })
  channels?: NotificationChannel[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  templateCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  audienceValue?: string;
  @ApiPropertyOptional({ enum: NotificationSeverity })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  severity?: NotificationSeverity;
  @ApiPropertyOptional({ enum: NotificationSeverity, nullable: true })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  minSeverity?: NotificationSeverity | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  critical?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateEscalationRuleDto {
  @ApiProperty({ example: 'ESC_DELAYED_STAGE_L3' })
  @Trim()
  @Matches(CODE)
  code!: string;
  @ApiProperty({ enum: ATTENTION_TYPES })
  @IsIn([...ATTENTION_TYPES])
  alertType!: string;
  @ApiPropertyOptional({ enum: NotificationSeverity })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  minSeverity?: NotificationSeverity;
  @ApiProperty({
    minimum: 1,
    maximum: 5,
    description: 'Each level fires once per alert; at most 5 levels',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  level!: number;
  @ApiProperty({
    example: 480,
    description: 'Working minutes since the alert was first detected',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(525_600)
  afterMinutes!: number;
  @ApiProperty({ enum: EscalationRecipientKind })
  @IsEnum(EscalationRecipientKind)
  recipientKind!: EscalationRecipientKind;
  @ApiPropertyOptional({ example: 'ADMIN', description: 'Required for ROLE' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  recipientRoleCode?: string;
  @ApiProperty({ enum: ['IN_APP', 'EMAIL'], isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(['IN_APP', 'EMAIL'], { each: true })
  channels!: NotificationChannel[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  critical?: boolean;
}

export class UpdateEscalationRuleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(525_600)
  afterMinutes?: number;
  @ApiPropertyOptional({ enum: NotificationSeverity, nullable: true })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  minSeverity?: NotificationSeverity | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  recipientRoleCode?: string;
  @ApiPropertyOptional({ enum: ['IN_APP', 'EMAIL'], isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(['IN_APP', 'EMAIL'], { each: true })
  channels?: NotificationChannel[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  critical?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListAlertsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AlertStatus })
  @IsOptional()
  @IsEnum(AlertStatus)
  status?: AlertStatus;
  @ApiPropertyOptional({ enum: ATTENTION_TYPES })
  @IsOptional()
  @IsIn([...ATTENTION_TYPES])
  type?: string;
  @ApiPropertyOptional({ enum: NotificationSeverity })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  severity?: NotificationSeverity;
}

export class RunTasksDto {
  @ApiPropertyOptional({
    enum: ['outbox', 'dispatch', 'alerts'],
    isArray: true,
    description: 'Default: all, in order',
  })
  @IsOptional()
  @IsArray()
  @IsIn(['outbox', 'dispatch', 'alerts'], { each: true })
  tasks?: ('outbox' | 'dispatch' | 'alerts')[];
}

export class ListRulesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventType?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  activeOnly?: boolean;
}
