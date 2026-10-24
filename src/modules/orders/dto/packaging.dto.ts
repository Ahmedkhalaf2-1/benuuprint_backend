import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../../common/transforms.js';

export class PackagingComponentInputDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A packaging / label component from master data',
  })
  @IsOptional()
  @IsUUID()
  componentOptionId?: string;
  @ApiPropertyOptional({ description: 'Instead of a master-data component' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  customName?: string;
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  quantityPerUnit?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdatePackagingSpecDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  foldingInstructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() polybagRequired?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() labelsRequired?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hangTagsRequired?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() stickersRequired?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  stickerNotes?: string;
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  unitsPerCarton?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  cartonNotes?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  specialInstructions?: string;
  @ApiPropertyOptional({
    type: [PackagingComponentInputDto],
    description: 'Replaces the component list',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PackagingComponentInputDto)
  components?: PackagingComponentInputDto[];
}

export class PackagingComponentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) componentOptionId!:
    string | null;
  @ApiProperty({ nullable: true }) componentCode!: string | null;
  @ApiProperty({ description: 'Master-data name or the custom name' })
  name!: string;
  @ApiProperty({ nullable: true }) category!: string | null;
  @ApiProperty({ nullable: true }) quantityPerUnit!: number | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class PackagingReportResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) jobStageId!: string;
  @ApiProperty() packedQuantity!: number;
  @ApiProperty() damagedQuantity!: number;
  @ApiProperty() cartonCount!: number;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) reportedByName!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class PackagingReconciliationDto {
  @ApiProperty({ description: 'Units that passed the final production stage' })
  completedQuantity!: number;
  @ApiProperty() packedQuantity!: number;
  @ApiProperty() damagedQuantity!: number;
  @ApiProperty() cartonCount!: number;
  @ApiProperty({
    description:
      'Packed units cover every produced unit (and something was produced)',
  })
  packagingComplete!: boolean;
  @ApiProperty({ description: 'Packed, produced and not yet on a shipment' })
  shippableQuantity!: number;
}

export class PackagingSpecResponseDto {
  @ApiProperty({ format: 'uuid', nullable: true }) id!: string | null;
  @ApiProperty() defined!: boolean;
  @ApiProperty({ nullable: true }) foldingInstructions!: string | null;
  @ApiProperty() polybagRequired!: boolean;
  @ApiProperty() labelsRequired!: boolean;
  @ApiProperty() hangTagsRequired!: boolean;
  @ApiProperty() stickersRequired!: boolean;
  @ApiProperty({ nullable: true }) stickerNotes!: string | null;
  @ApiProperty({ nullable: true }) unitsPerCarton!: number | null;
  @ApiProperty({ nullable: true }) cartonNotes!: string | null;
  @ApiProperty({ nullable: true }) specialInstructions!: string | null;
  @ApiProperty({ type: [PackagingComponentResponseDto] })
  components!: PackagingComponentResponseDto[];
  @ApiProperty({ type: PackagingReconciliationDto })
  reconciliation!: PackagingReconciliationDto;
  @ApiProperty({ type: [PackagingReportResponseDto] })
  reports!: PackagingReportResponseDto[];
  @ApiProperty({ nullable: true }) updatedAt!: Date | null;
}
