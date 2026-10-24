import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../../common/transforms.js';

const HHMM = /^([01]?\d|2[0-4]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateWorkingCalendarDto {
  @ApiProperty({ example: 'FACTORY_DEFAULT' })
  @Trim()
  @Matches(/^[A-Z0-9_]{2,60}$/, { message: 'code must be UPPER_SNAKE_CASE' })
  code!: string;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
  @ApiProperty({
    example: 'Africa/Cairo',
    description: 'IANA time zone of the schedule',
  })
  @Trim()
  @IsString()
  timezone!: string;
  @ApiPropertyOptional({
    description:
      'Hours per weekday (0 = Sunday); omitted weekdays are non-working. Default: Sun–Thu 09:00–17:00',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => WorkingDayDto)
  days?: WorkingDayDto[];
}

export class UpdateWorkingCalendarDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  timezone?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class WorkingDayDto {
  @ApiProperty({
    minimum: 0,
    maximum: 6,
    description: '0 = Sunday … 6 = Saturday',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;
  @ApiProperty()
  @IsBoolean()
  isWorkingDay!: boolean;
  @ApiPropertyOptional({ example: '09:00' })
  @IsOptional()
  @Matches(HHMM, { message: 'startTime must be HH:MM' })
  startTime?: string;
  @ApiPropertyOptional({
    example: '17:00',
    description: '24:00 means until midnight',
  })
  @IsOptional()
  @Matches(HHMM, { message: 'endTime must be HH:MM' })
  endTime?: string;
}

export class SetWeeklyScheduleDto {
  @ApiProperty({ type: [WorkingDayDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => WorkingDayDto)
  days!: WorkingDayDto[];
}

export class SetCalendarExceptionDto {
  @ApiProperty({ example: '2031-01-06' })
  @Matches(DAY, { message: 'date must be YYYY-MM-DD' })
  date!: string;
  @ApiProperty({
    description: 'false = holiday; true = exceptional or shortened working day',
  })
  @IsBoolean()
  isWorkingDay!: boolean;
  @ApiPropertyOptional({ example: '10:00' })
  @IsOptional()
  @Matches(HHMM)
  startTime?: string;
  @ApiPropertyOptional({ example: '14:00' })
  @IsOptional()
  @Matches(HHMM)
  endTime?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class CalendarPreviewQueryDto {
  @ApiPropertyOptional({ example: '2031-01-01', description: 'Default: today' })
  @IsOptional()
  @Matches(DAY)
  from?: string;
  @ApiPropertyOptional({
    example: '2031-01-31',
    description: 'Inclusive, at most 62 days; default from + 13',
  })
  @IsOptional()
  @Matches(DAY)
  to?: string;
}
