import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CodeField,
  NameField,
  NullableInt,
  NullableText,
  OptBool,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { NormalizeCode, Trim } from '../../../common/transforms.js';
import {
  DepartmentType,
  WorkflowVersionStatus,
} from '../../../generated/prisma/client.js';

export class WorkflowStageInputDto {
  @ApiProperty({
    example: 'CUTTING',
    description: 'Code of a production stage definition',
  })
  @NormalizeCode()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  stageCode!: string;

  @ApiProperty({
    example: 3,
    description: 'Position/identity of this entry inside the workflow',
  })
  @IsInt()
  @Min(0)
  @Max(10000)
  sequence!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
  @NullableInt(1, 100000) expectedDurationMinutes?: number | null;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  canRunInParallel?: boolean;

  @ApiPropertyOptional({
    type: [Number],
    description:
      'Sequences that must be complete first. Omit for "the previous stage" (sequential); [] makes this a root, which is how parallel branches start.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsInt({ each: true })
  dependsOnSequences?: number[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  config?: Record<string, unknown>;
}

export class CreateWorkflowTemplateDto {
  @CodeField('BENUE_PRINTED_APPAREL') code!: string;
  @NameField() name!: string;
  @OptText(1000) description?: string;
  @ApiProperty({
    type: [WorkflowStageInputDto],
    description: 'Stages of version 1 (created as a DRAFT)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStageInputDto)
  stages!: WorkflowStageInputDto[];
  @OptText(1000) notes?: string;
}

export class UpdateWorkflowTemplateDto {
  @OptText(120) name?: string;
  @NullableText(1000) description?: string | null;
  @ApiPropertyOptional({
    description:
      'true makes this the default template (the previous default is cleared)',
  })
  @OptBool()
  isDefault?: boolean;
}

export class CreateWorkflowVersionDto {
  @ApiPropertyOptional({
    type: [WorkflowStageInputDto],
    description: "Omit to copy the latest version's stages as a starting point",
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStageInputDto)
  stages?: WorkflowStageInputDto[];
  @OptText(1000) notes?: string;
}

export class ReplaceWorkflowStagesDto {
  @ApiProperty({
    type: [WorkflowStageInputDto],
    description: 'Replaces every stage of a DRAFT version',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStageInputDto)
  stages!: WorkflowStageInputDto[];
  @OptText(1000) notes?: string;
}

export class WorkflowStageResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() sequence!: number;
  @ApiProperty() stageCode!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty({ enum: DepartmentType }) departmentType!: DepartmentType;
  @ApiProperty() isRequired!: boolean;
  @ApiProperty() isQcStage!: boolean;
  @ApiProperty({ nullable: true }) expectedDurationMinutes!: number | null;
  @ApiProperty() canRunInParallel!: boolean;
  @ApiProperty({ type: [Number] }) dependsOnSequences!: number[];
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  config!: Record<string, unknown> | null;
}

export class WorkflowVersionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) templateId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: WorkflowVersionStatus }) status!: WorkflowVersionStatus;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) activatedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: [WorkflowStageResponseDto] })
  stages!: WorkflowStageResponseDto[];
}

export class WorkflowTemplateResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({
    nullable: true,
    description: 'Version number of the ACTIVE version (what new jobs use)',
  })
  activeVersion!: number | null;
  @ApiProperty({
    type: [WorkflowVersionResponseDto],
    description: 'Newest first',
  })
  versions!: WorkflowVersionResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedWorkflowTemplatesDto {
  @ApiProperty({ type: [WorkflowTemplateResponseDto] })
  data!: WorkflowTemplateResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class CreateStageDefinitionDto {
  @CodeField('EMBROIDERY') code!: string;
  @NameField() name!: string;
  @OptText(1000) description?: string;
  @ApiProperty({ enum: DepartmentType })
  @IsEnum(DepartmentType)
  departmentType!: DepartmentType;
  @OptInt(0, 100000) defaultSequence?: number;
  @OptInt(1, 100000) expectedDurationMinutes?: number;
  @OptBool() requiresAssignment?: boolean;
  @OptBool() requiresCompletionNote?: boolean;
  @OptBool() requiresAttachment?: boolean;
  @ApiPropertyOptional({
    default: false,
    description: 'QC stages are completed through QC inspections',
  })
  @OptBool()
  isQcStage?: boolean;
  @ApiPropertyOptional({
    type: [String],
    description:
      'Role codes allowed to work this stage (empty = any staff who can start stages)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @NormalizeCode()
  @IsString({ each: true })
  eligibleRoleCodes?: string[];
}

export class UpdateStageDefinitionDto {
  @OptText(120) name?: string;
  @NullableText(1000) description?: string | null;
  @NullableInt(1, 100000) expectedDurationMinutes?: number | null;
  @OptBool() requiresAssignment?: boolean;
  @OptBool() requiresCompletionNote?: boolean;
  @OptBool() requiresAttachment?: boolean;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({ each: true })
  eligibleRoleCodes?: string[];
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) defaultSequence?: number;
}

export class StageDefinitionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: DepartmentType }) departmentType!: DepartmentType;
  @ApiProperty() defaultSequence!: number;
  @ApiProperty({ nullable: true }) expectedDurationMinutes!: number | null;
  @ApiProperty() requiresAssignment!: boolean;
  @ApiProperty() requiresCompletionNote!: boolean;
  @ApiProperty() requiresAttachment!: boolean;
  @ApiProperty() isQcStage!: boolean;
  @ApiProperty({ type: [String] }) eligibleRoleCodes!: string[];
  @ApiProperty() isActive!: boolean;
}

export class ListWorkflowTemplatesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;
}
