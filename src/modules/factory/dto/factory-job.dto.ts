import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { NormalizeCode, ToBoolean, Trim } from '../../../common/transforms.js';
import {
  NullableText,
  OptEnum,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  BlockerStatus,
  BlockerType,
  DepartmentType,
  FactoryJobSourceType,
  FactoryJobStatus,
  JobActivityType,
  JobPriority,
  JobStageStatus,
  ReworkStatus,
} from '../../../generated/prisma/client.js';

export const JOB_SORTS = ['newest', 'oldest', 'priority', 'target'] as const;

export class CreateFactoryJobDto {
  @ApiPropertyOptional({
    example: 'BENUE_STANDARD_APPAREL',
    description: 'Workflow template code; defaults to the default template',
  })
  @IsOptional()
  @NormalizeCode()
  @IsString()
  @MaxLength(50)
  workflowTemplateCode?: string;
  @OptEnum(JobPriority) priority?: JobPriority;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  requestedStartDate?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetCompletionDate?: Date;
  @OptText(2000) internalNotes?: string;
  @ApiPropertyOptional({
    default: true,
    description:
      'false creates the job PLANNED (stages WAITING) so stages can be assigned first; release it later',
  })
  @IsOptional()
  @IsBoolean()
  release?: boolean;
}

export class ReasonBodyDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ChangePriorityDto {
  @ApiProperty({ enum: JobPriority })
  @IsEnum(JobPriority)
  priority!: JobPriority;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListFactoryJobsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Job number, sample number, brand, customer name/number',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({ enum: FactoryJobStatus, isArray: true })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsEnum(FactoryJobStatus, { each: true })
  status?: FactoryJobStatus[];
  @OptEnum(JobPriority) priority?: JobPriority;
  @ApiPropertyOptional({ enum: FactoryJobSourceType })
  @IsOptional()
  @IsEnum(FactoryJobSourceType)
  sourceType?: FactoryJobSourceType;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  orderId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productTypeId?: string;
  @ApiPropertyOptional({
    description: 'Only jobs with at least one open stage past its due date',
  })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  delayed?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  createdFrom?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  createdTo?: Date;
  @ApiPropertyOptional({
    description: 'Target completion on or before this date',
  })
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  targetBefore?: Date;
  @ApiPropertyOptional({ enum: JOB_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(JOB_SORTS)
  sort: (typeof JOB_SORTS)[number] = 'newest';
}

export class StageAssigneeDto {
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty({ nullable: true }) context!: string | null;
  @ApiProperty() assignedAt!: Date;
}

export class JobStageResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty() stageCode!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty({ enum: DepartmentType }) departmentType!: DepartmentType;
  @ApiProperty() sequence!: number;
  @ApiProperty({ description: '1 for the original run; rework adds 2, 3, …' })
  attempt!: number;
  @ApiProperty({ enum: JobStageStatus }) status!: JobStageStatus;
  @ApiProperty() isRequired!: boolean;
  @ApiProperty() isQcStage!: boolean;
  @ApiProperty() requiresAssignment!: boolean;
  @ApiProperty() requiresCompletionNote!: boolean;
  @ApiProperty() requiresAttachment!: boolean;
  @ApiProperty({
    description:
      'Replaced by a newer occurrence after rework (kept as history)',
  })
  superseded!: boolean;
  @ApiProperty({
    type: [String],
    description: 'Stages that must be done first',
  })
  dependsOnStageIds!: string[];
  @ApiProperty({ nullable: true }) readyAt!: Date | null;
  @ApiProperty({ nullable: true }) dueAt!: Date | null;
  @ApiProperty({ nullable: true }) startedAt!: Date | null;
  @ApiProperty({ nullable: true }) completedAt!: Date | null;
  @ApiProperty({ description: 'Derived: open and past its due date' })
  isDelayed!: boolean;
  @ApiProperty() isOnHold!: boolean;
  @ApiProperty({ nullable: true }) holdReason!: string | null;
  @ApiProperty({ nullable: true }) blockedAt!: Date | null;
  @ApiProperty({ nullable: true }) blockReason!: string | null;
  @ApiProperty({ nullable: true }) completionNote!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) reworkRecordId!:
    string | null;
  @ApiProperty({ type: [StageAssigneeDto] }) assignees!: StageAssigneeDto[];
}

export class JobPartyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) number!: string | null;
}

export class FactoryJobListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'JOB-000001' }) jobNumber!: string;
  @ApiProperty({ enum: FactoryJobSourceType })
  sourceType!: FactoryJobSourceType;
  @ApiProperty({ enum: FactoryJobStatus }) status!: FactoryJobStatus;
  @ApiProperty({ enum: JobPriority }) priority!: JobPriority;
  @ApiProperty({ nullable: true, example: 'SMP-000001' }) sampleNumber!:
    string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) orderId!: string | null;
  @ApiProperty({ nullable: true, example: 'ORD-000001' }) orderNumber!:
    string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) orderBatchId!: string | null;
  @ApiProperty({ nullable: true, example: 'BAT-000001' }) batchNumber!:
    string | null;
  @ApiProperty({
    nullable: true,
    description:
      'Units this job produces (bulk jobs); null for sample production',
  })
  plannedQuantity!: number | null;
  @ApiProperty() completedQuantity!: number;
  @ApiProperty() rejectedQuantity!: number;
  @ApiProperty({ type: JobPartyDto }) customer!: JobPartyDto;
  @ApiProperty({ type: JobPartyDto }) brand!: JobPartyDto;
  @ApiProperty() productName!: string;
  @ApiProperty({ example: 'BENUE_STANDARD_APPAREL' }) workflowCode!: string;
  @ApiProperty() workflowVersion!: number;
  @ApiProperty({ nullable: true }) targetCompletionDate!: Date | null;
  @ApiProperty() progress!: { completedStages: number; totalStages: number };
  @ApiProperty() delayedStages!: number;
  @ApiProperty() openBlockers!: number;
  @ApiProperty({ nullable: true }) startedAt!: Date | null;
  @ApiProperty({ nullable: true }) completedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedFactoryJobsDto {
  @ApiProperty({ type: [FactoryJobListItemDto] })
  data!: FactoryJobListItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class FactoryJobDetailDto extends FactoryJobListItemDto {
  @ApiProperty({ format: 'uuid' }) sampleId!: string | null;
  @ApiProperty({
    format: 'uuid',
    description: 'The immutable approved specification this job produces',
  })
  sampleProductionSpecId!: string;
  @ApiProperty() specRevision!: number;
  @ApiProperty({ description: 'SHA-256 of the frozen specification' })
  specHash!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) assignedSalesUserId!:
    string | null;
  @ApiProperty({ nullable: true }) requestedStartDate!: Date | null;
  @ApiProperty({ nullable: true }) holdReason!: string | null;
  @ApiProperty({ nullable: true }) heldAt!: Date | null;
  @ApiProperty({ nullable: true }) cancelReason!: string | null;
  @ApiProperty({ nullable: true }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true }) internalNotes!: string | null;
  @ApiProperty({
    type: [JobStageResponseDto],
    description:
      'Current stages in order (rework occurrences included, history kept)',
  })
  stages!: JobStageResponseDto[];
}

export class BlockerResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) jobStageId!: string | null;
  @ApiProperty({ nullable: true }) stageName!: string | null;
  @ApiProperty({ enum: BlockerType }) type!: BlockerType;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: BlockerStatus }) status!: BlockerStatus;
  @ApiProperty({ format: 'uuid' }) createdByUserId!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) resolvedByUserId!:
    string | null;
  @ApiProperty({ nullable: true }) resolutionNote!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) resolvedAt!: Date | null;
}

export class RaiseBlockerDto {
  @ApiProperty({ enum: BlockerType }) @IsEnum(BlockerType) type!: BlockerType;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  description!: string;
}

export class ResolveBlockerDto {
  @ApiPropertyOptional({ description: 'What was done to clear it' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class UnblockStageDto extends ResolveBlockerDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Resolve one blocker; omit to resolve every open blocker of the stage',
  })
  @IsOptional()
  @IsUUID()
  blockerId?: string;
}

export class ReworkResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ format: 'uuid' }) failedStageId!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) qcInspectionId!:
    string | null;
  @ApiProperty() targetStageCode!: string;
  @ApiProperty() targetStageName!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({
    nullable: true,
    description: 'Units sent back (bulk jobs); null for sample production',
  })
  affectedQuantity!: number | null;
  @ApiProperty({ enum: ReworkStatus }) status!: ReworkStatus;
  @ApiProperty({
    type: [String],
    description: 'The new stage occurrences created for this rework',
  })
  newStageIds!: string[];
  @ApiProperty({ format: 'uuid' }) createdByUserId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) resolvedAt!: Date | null;
}

export class ManualReworkDto {
  @ApiPropertyOptional({
    example: 'CUTTING',
    description:
      'Earlier stage to redo; defaults to the stage this one depends on',
  })
  @IsOptional()
  @NormalizeCode()
  @IsString()
  @MaxLength(50)
  targetStageCode?: string;
  @ApiPropertyOptional({
    description: 'Units sent back; required for bulk jobs',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  affectedQuantity?: number;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class TimelineQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only events of this stage',
  })
  @IsOptional()
  @IsUUID()
  jobStageId?: string;
}

export class ActivityResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: JobActivityType }) type!: JobActivityType;
  @ApiProperty() message!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) jobStageId!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) actorUserId!: string | null;
  @ApiProperty({ nullable: true }) actorName!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown> | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedActivitiesDto {
  @ApiProperty({ type: [ActivityResponseDto] }) data!: ActivityResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class CreateJobNoteDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Attach the note to a stage of the job',
  })
  @IsOptional()
  @IsUUID()
  jobStageId?: string;
}

export class JobNoteResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) jobStageId!: string | null;
  @ApiProperty({ enum: ['INTERNAL'] }) visibility!: 'INTERNAL';
  @ApiProperty() content!: string;
  @ApiProperty({ format: 'uuid' }) authorUserId!: string;
  @ApiProperty() authorName!: string;
  @ApiProperty() createdAt!: Date;
}

export class UpdateInternalNotesDto {
  @NullableText(2000) internalNotes?: string | null;
}
