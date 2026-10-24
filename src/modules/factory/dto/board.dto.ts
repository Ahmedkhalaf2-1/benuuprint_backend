import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { NormalizeCode, ToBoolean } from '../../../common/transforms.js';
import { OptEnum } from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  DepartmentType,
  JobPriority,
  JobStageStatus,
} from '../../../generated/prisma/client.js';
import { StageAssigneeDto } from './factory-job.dto.js';

export class BoardQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'CUTTING',
    description: 'Return only this column, paginated',
  })
  @IsOptional()
  @NormalizeCode()
  @IsString()
  @MaxLength(50)
  stageCode?: string;
  @ApiPropertyOptional({
    enum: JobStageStatus,
    isArray: true,
    description: 'Default READY, IN_PROGRESS, BLOCKED',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsEnum(JobStageStatus, { each: true })
  status?: JobStageStatus[];
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedUserId?: string;
  @ApiPropertyOptional({ description: 'Only stages nobody is assigned to' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  unassigned?: boolean;
  @OptEnum(JobPriority) priority?: JobPriority;
  @ApiPropertyOptional({ description: 'Open and past its due date' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  delayed?: boolean;
  @ApiPropertyOptional({ description: 'Only blocked stages' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  blocked?: boolean;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productTypeId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdFrom?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdTo?: Date;
  @ApiPropertyOptional({
    default: 20,
    description: 'Cards per column when no stageCode is given',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  columnLimit?: number;
}

export class BoardCardDto {
  @ApiProperty({ format: 'uuid' }) stageId!: string;
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty() jobNumber!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() brandName!: string;
  @ApiProperty() customerName!: string;
  @ApiProperty({ enum: JobPriority }) priority!: JobPriority;
  @ApiProperty({ enum: JobStageStatus }) status!: JobStageStatus;
  @ApiProperty() attempt!: number;
  @ApiProperty() isDelayed!: boolean;
  @ApiProperty() isOnHold!: boolean;
  @ApiProperty({ nullable: true }) dueAt!: Date | null;
  @ApiProperty({ nullable: true }) readyAt!: Date | null;
  @ApiProperty({ nullable: true }) startedAt!: Date | null;
  @ApiProperty({ nullable: true }) blockReason!: string | null;
  @ApiProperty({ type: [StageAssigneeDto] }) assignees!: StageAssigneeDto[];
}

export class BoardColumnDto {
  @ApiProperty() stageCode!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty({ enum: DepartmentType }) departmentType!: DepartmentType;
  @ApiProperty() sequence!: number;
  @ApiProperty({
    description: 'Matching stages per status (not limited by columnLimit)',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  counts!: Record<string, number>;
  @ApiProperty() total!: number;
  @ApiProperty({ type: [BoardCardDto] }) cards!: BoardCardDto[];
}

export class ProductionBoardDto {
  @ApiProperty({ type: [BoardColumnDto] }) columns!: BoardColumnDto[];
  @ApiPropertyOptional({
    type: PaginationMetaDto,
    description: 'Present when stageCode is given',
  })
  meta?: PaginationMetaDto;
}
