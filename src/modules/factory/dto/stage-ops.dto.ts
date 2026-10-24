import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/transforms.js';

export class AssignStageDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() userId!: string;
  @ApiPropertyOptional({
    description:
      'Make this person the primary assignee (the first assignee is primary by default)',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
  @ApiPropertyOptional({ example: 'Lead cutter' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  context?: string;
}

export class CompleteStageDto {
  @ApiPropertyOptional({
    description:
      'Required when the stage is configured to require a completion note',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class OverrideStageDto {
  @ApiProperty({ enum: ['complete', 'skip'] })
  @IsIn(['complete', 'skip'])
  action!: 'complete' | 'skip';
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}
