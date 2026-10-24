import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  AssetType,
  FactoryJobStatus,
  JobPriority,
  JobStageStatus,
} from '../../../generated/prisma/client.js';
import {
  BlockerResponseDto,
  JobNoteResponseDto,
  JobStageResponseDto,
} from './factory-job.dto.js';
import { QcInspectionResponseDto } from './qc.dto.js';
import { StageQuantityDto } from './quantity.dto.js';

export const STAGE_ACTIONS = [
  'START',
  'COMPLETE',
  'RAISE_BLOCKER',
  'START_QC',
  'ADD_NOTE',
  'ATTACH_FILE',
] as const;

export class ListMyStagesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: JobStageStatus,
    isArray: true,
    description: 'Defaults to open stages (READY, IN_PROGRESS, BLOCKED)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsEnum(JobStageStatus, { each: true })
  status?: JobStageStatus[];
  @ApiPropertyOptional()
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  delayed?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ListMyJobsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Include finished and cancelled jobs' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  includeClosed?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class StaffJobSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() jobNumber!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() brandName!: string;
  @ApiProperty({ enum: JobPriority }) priority!: JobPriority;
  @ApiProperty({ enum: FactoryJobStatus }) status!: FactoryJobStatus;
  @ApiProperty({ nullable: true }) targetCompletionDate!: Date | null;
}

export class StaffStageListItemDto extends JobStageResponseDto {
  @ApiProperty({ type: StaffJobSummaryDto }) job!: StaffJobSummaryDto;
}

export class PaginatedStaffStagesDto {
  @ApiProperty({ type: [StaffStageListItemDto] })
  data!: StaffStageListItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class StaffJobListItemDto extends StaffJobSummaryDto {
  @ApiProperty({
    type: [StaffStageListItemDto],
    description: 'Only the stages assigned to the caller',
  })
  myStages!: JobStageResponseDto[];
}

export class PaginatedStaffJobsDto {
  @ApiProperty({ type: [StaffJobListItemDto] }) data!: StaffJobListItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class StageFileDto {
  @ApiProperty({ format: 'uuid' }) attachmentId!: string;
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty({ enum: AssetType }) type!: AssetType;
  @ApiProperty() originalName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class StaffStageDetailDto {
  @ApiProperty({ type: JobStageResponseDto }) stage!: JobStageResponseDto;
  @ApiProperty({ type: StaffJobSummaryDto }) job!: StaffJobSummaryDto;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'What this department needs, taken from the frozen approved specification. Never contains customer contact details, prices, payments, terms or approvals. Files appear as asset references; fetch them through the stage download-url endpoint.',
  })
  taskView!: Record<string, unknown>;
  @ApiProperty({ enum: STAGE_ACTIONS, isArray: true })
  allowedActions!: (typeof STAGE_ACTIONS)[number][];
  @ApiProperty({ type: [BlockerResponseDto] }) blockers!: BlockerResponseDto[];
  @ApiProperty({ type: [JobNoteResponseDto] }) notes!: JobNoteResponseDto[];
  @ApiProperty({ type: [StageFileDto] }) files!: StageFileDto[];
  @ApiPropertyOptional({
    type: StageQuantityDto,
    nullable: true,
    description:
      'Bulk jobs: units this stage must account for, reported so far and remaining',
  })
  quantity?: StageQuantityDto | null;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Bulk jobs: order number, units and the size / colour breakdown to produce (restricted to the batch allocation for batch jobs). No prices or customer data.',
  })
  orderView?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: QcInspectionResponseDto, nullable: true })
  qcInspection?: QcInspectionResponseDto | null;
}

export class UploadEvidenceDto {
  @ApiPropertyOptional({
    enum: [
      'STAGE_PHOTO',
      'QC_PHOTO',
      'PATTERN_OUTPUT',
      'PRINT_PROOF',
      'PRODUCTION_REFERENCE',
      'OTHER',
    ],
  })
  @IsOptional()
  @IsIn([
    'STAGE_PHOTO',
    'QC_PHOTO',
    'PATTERN_OUTPUT',
    'PRINT_PROOF',
    'PRODUCTION_REFERENCE',
    'OTHER',
  ])
  type?:
    | 'STAGE_PHOTO'
    | 'QC_PHOTO'
    | 'PATTERN_OUTPUT'
    | 'PRINT_PROOF'
    | 'PRODUCTION_REFERENCE'
    | 'OTHER';
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
