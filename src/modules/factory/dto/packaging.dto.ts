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

const MAX = 10_000_000;

export class ReportPackagingDto {
  @ApiProperty({ description: 'Units packed in this report', minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX)
  packedQuantity!: number;
  @ApiPropertyOptional({
    description: 'Units damaged while packing (scrapped)',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX)
  damagedQuantity?: number;
  @ApiPropertyOptional({
    description: 'Cartons filled in this report',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  cartonCount?: number;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Order variant these units belong to',
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
