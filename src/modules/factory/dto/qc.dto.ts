import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { NormalizeCode, ToBoolean, Trim } from '../../../common/transforms.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  QcInspectionStatus,
  QcItemResult,
  QcOverallResult,
  QcResultType,
} from '../../../generated/prisma/client.js';

export class QcItemInputDto {
  @ApiProperty({ example: 'CUT_PIECES_COMPLETE' })
  @NormalizeCode()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  code!: string;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  label!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  description?: string;
  @ApiProperty({ enum: QcResultType })
  @IsEnum(QcResultType)
  resultType!: QcResultType;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
  @ApiPropertyOptional({
    description: 'e.g. { "unit": "cm", "target": 25, "tolerance": 0.5 }',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class CreateQcTemplateVersionDto {
  @ApiProperty({
    example: 'CUTTING',
    description: 'The QC stage definition this checklist belongs to',
  })
  @NormalizeCode()
  @IsString()
  @MaxLength(50)
  stageCode!: string;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  description?: string;
  @ApiProperty({ type: [QcItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QcItemInputDto)
  items!: QcItemInputDto[];
}

export class QcItemResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: QcResultType }) resultType!: QcResultType;
  @ApiProperty() required!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  config!: Record<string, unknown> | null;
}

export class QcTemplateResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ format: 'uuid' }) stageDefinitionId!: string;
  @ApiProperty() stageCode!: string;
  @ApiProperty({ type: [QcItemResponseDto] }) items!: QcItemResponseDto[];
  @ApiProperty() createdAt!: Date;
}

export class ListQcTemplatesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'QC_GATE_1' })
  @IsOptional()
  @NormalizeCode()
  @IsString()
  stageCode?: string;
  @ApiPropertyOptional({
    description: 'Only the active version of each template',
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  activeOnly?: boolean;
}

export class PaginatedQcTemplatesDto {
  @ApiProperty({ type: [QcTemplateResponseDto] })
  data!: QcTemplateResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class QcResultInputDto {
  @ApiProperty({
    example: 'CUT_PIECES_COMPLETE',
    description: 'Checklist item code',
  })
  @NormalizeCode()
  @IsString()
  @MaxLength(60)
  itemCode!: string;
  @ApiPropertyOptional({ enum: QcItemResult })
  @IsOptional()
  @IsEnum(QcItemResult)
  result?: QcItemResult;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  numericValue?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  textValue?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class SaveQcResultsDto {
  @ApiProperty({ type: [QcResultInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QcResultInputDto)
  results!: QcResultInputDto[];
}

export class CompleteQcInspectionDto {
  @ApiProperty({ enum: QcOverallResult })
  @IsEnum(QcOverallResult)
  overallResult!: QcOverallResult;
  @ApiPropertyOptional({
    description: 'Required for FAIL and CONDITIONAL_PASS',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @ApiPropertyOptional({
    description:
      'Bulk jobs: units inspected (must equal the units this gate handles)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  inspectedQuantity?: number;
  @ApiPropertyOptional({ description: 'Bulk jobs: units that passed' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  passedQuantity?: number;
  @ApiPropertyOptional({
    description: 'Bulk jobs: units that failed; they go to rework',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  failedQuantity?: number;
  @ApiPropertyOptional({
    description:
      'Rework target for a FAIL; defaults to the stage this gate checks',
  })
  @IsOptional()
  @NormalizeCode()
  @IsString()
  @MaxLength(50)
  reworkTargetStageCode?: string;
}

export class QcResultResponseDto {
  @ApiProperty({ format: 'uuid' }) itemId!: string;
  @ApiProperty() itemCode!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: QcResultType }) resultType!: QcResultType;
  @ApiProperty() required!: boolean;
  @ApiProperty({ enum: QcItemResult, nullable: true })
  result!: QcItemResult | null;
  @ApiProperty({ nullable: true }) numericValue!: number | null;
  @ApiProperty({ nullable: true }) textValue!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class QcInspectionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ format: 'uuid' }) jobStageId!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty() templateCode!: string;
  @ApiProperty() templateVersion!: number;
  @ApiProperty({ enum: QcInspectionStatus }) status!: QcInspectionStatus;
  @ApiProperty({ enum: QcOverallResult, nullable: true })
  overallResult!: QcOverallResult | null;
  @ApiProperty({ format: 'uuid' }) inspectorUserId!: string;
  @ApiProperty() inspectorName!: string;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() startedAt!: Date;
  @ApiProperty({ nullable: true }) completedAt!: Date | null;
  @ApiProperty() photoCount!: number;
  @ApiProperty({ type: [QcResultResponseDto] }) results!: QcResultResponseDto[];
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Set when a FAIL created rework',
  })
  reworkId?: string | null;
  @ApiProperty({ nullable: true }) inspectedQuantity!: number | null;
  @ApiProperty({ nullable: true }) passedQuantity!: number | null;
  @ApiProperty({ nullable: true }) failedQuantity!: number | null;
}
