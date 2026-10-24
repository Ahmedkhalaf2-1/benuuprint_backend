import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from '../../../common/transforms.js';

const MAX_UNITS = 10_000_000;

export class ReportQuantityDto {
  @ApiPropertyOptional({
    description: 'Good units finished in this report',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_UNITS)
  producedQuantity?: number;
  @ApiPropertyOptional({
    description: 'Units scrapped in this report',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_UNITS)
  rejectedQuantity?: number;
  @ApiPropertyOptional({
    description:
      'Units flagged for rework (informational; they do not count towards the stage total)',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_UNITS)
  reworkQuantity?: number;
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Order variant these units belong to (updates the variant counters on the final stage)',
  })
  @IsOptional()
  @IsUUID()
  orderVariantId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class StageQuantityDto {
  @ApiProperty({
    description:
      'Units this stage occurrence must account for (produced + rejected)',
  })
  required!: number;
  @ApiProperty() produced!: number;
  @ApiProperty() rejected!: number;
  @ApiProperty({ description: 'Units flagged for rework in reports' })
  reworkFlagged!: number;
  @ApiProperty({ description: 'Units still to be reported' })
  remaining!: number;
  @ApiProperty({
    nullable: true,
    description:
      'Set when this occurrence only redoes units sent back by rework',
  })
  reworkAffectedQuantity!: number | null;
}

export class StageProductionReportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) jobStageId!: string;
  @ApiProperty() producedQuantity!: number;
  @ApiProperty() rejectedQuantity!: number;
  @ApiProperty() reworkQuantity!: number;
  @ApiProperty({ nullable: true, format: 'uuid' }) orderVariantId!:
    string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ format: 'uuid' }) reportedByUserId!: string;
  @ApiProperty({ nullable: true }) reportedByName!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class StageReportsResponseDto {
  @ApiProperty({ type: StageQuantityDto }) quantity!: StageQuantityDto;
  @ApiProperty({ type: [StageProductionReportDto] })
  reports!: StageProductionReportDto[];
}
