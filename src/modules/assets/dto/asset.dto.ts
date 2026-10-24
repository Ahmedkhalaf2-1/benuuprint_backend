import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { NullableOptional } from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import { AssetType } from '../../../generated/prisma/client.js';

export const ASSET_TARGET_TYPES = [
  'CUSTOMER',
  'BRAND',
  'FABRIC',
  'PATTERN_VERSION',
  'PRODUCT_TYPE',
  'PRINT_METHOD',
  'SAMPLE',
  'FACTORY_JOB',
  'JOB_STAGE',
  'QC_INSPECTION',
] as const;
export type AssetTargetType = (typeof ASSET_TARGET_TYPES)[number];

export class UploadAssetDto {
  @ApiProperty({ enum: AssetType })
  @IsEnum(AssetType)
  type!: AssetType;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateAssetDto {
  @ApiPropertyOptional({ enum: AssetType })
  @IsOptional()
  @IsEnum(AssetType)
  type?: AssetType;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class ListAssetsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches the original file name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: AssetType })
  @IsOptional()
  @IsEnum(AssetType)
  type?: AssetType;

  @ApiPropertyOptional({
    enum: ASSET_TARGET_TYPES,
    description: 'Use with targetId',
  })
  @IsOptional()
  @IsIn(ASSET_TARGET_TYPES)
  targetType?: AssetTargetType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ description: 'Include archived assets' })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;
}

export class DownloadUrlQueryDto {
  @ApiPropertyOptional({
    enum: ['attachment', 'inline'],
    default: 'attachment',
  })
  @IsOptional()
  @IsIn(['attachment', 'inline'])
  disposition?: 'attachment' | 'inline';
}

export class AttachAssetDto {
  @ApiProperty({ enum: ASSET_TARGET_TYPES })
  @IsIn(ASSET_TARGET_TYPES)
  targetType!: AssetTargetType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetId!: string;
}

/** Never exposes the storage key, provider or any filesystem path. */
export class AssetResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: AssetType }) type!: AssetType;
  @ApiProperty() originalName!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ example: 'image/png' }) mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ nullable: true, description: 'SHA-256 hex' }) checksum!:
    string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) uploadedByStaffUserId!:
    string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedAssetsDto {
  @ApiProperty({ type: [AssetResponseDto] }) data!: AssetResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class DownloadUrlResponseDto {
  @ApiProperty({
    description:
      'Short-lived URL; relative to the API origin for the local provider',
  })
  url!: string;
  @ApiProperty() expiresAt!: Date;
}

export class AttachmentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty({ enum: ASSET_TARGET_TYPES }) targetType!: AssetTargetType;
  @ApiProperty({ format: 'uuid' }) targetId!: string;
  @ApiProperty() createdAt!: Date;
}
