import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  NullableText,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import {
  ArtworkPurpose,
  ArtworkVersionStatus,
} from '../../../generated/prisma/client.js';

export class CreateArtworkDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Brand-owned (reusable) artwork. Exactly one of brandId / sampleId.',
  })
  @IsOptional()
  @IsUUID()
  brandId?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sample-owned artwork. Exactly one of brandId / sampleId.',
  })
  @IsOptional()
  @IsUUID()
  sampleId?: string;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
  @ApiPropertyOptional({
    enum: ArtworkPurpose,
    default: ArtworkPurpose.GENERAL_REFERENCE,
  })
  @IsOptional()
  @IsEnum(ArtworkPurpose)
  purpose?: ArtworkPurpose;
  @ApiProperty({
    format: 'uuid',
    description:
      'Uploaded asset for version 1 (ARTWORK, LOGO, MOCKUP, REFERENCE, LABEL, PACKAGING_REFERENCE or OTHER)',
  })
  @IsUUID()
  assetId!: string;
  @OptText(1000) notes?: string;
}

export class UpdateArtworkDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
  @ApiPropertyOptional({ enum: ArtworkPurpose })
  @IsOptional()
  @IsEnum(ArtworkPurpose)
  purpose?: ArtworkPurpose;
}

export class CreateArtworkVersionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A new uploaded file; versions are never edited in place',
  })
  @IsUUID()
  assetId!: string;
  @OptText(1000) notes?: string;
}

export class UpdateArtworkVersionDto {
  @NullableText(1000) notes?: string | null;
}

export class ListArtworksQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sampleId?: string;
  @ApiPropertyOptional({ enum: ArtworkPurpose })
  @IsOptional()
  @IsEnum(ArtworkPurpose)
  purpose?: ArtworkPurpose;
  @ApiPropertyOptional({ description: 'Matches the artwork name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({ description: 'Include archived artwork' })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;
}

export class ArtworkAssetDto {
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty() type!: string;
  @ApiProperty() originalName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
}

export class ArtworkVersionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) artworkId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ enum: ArtworkVersionStatus }) status!: ArtworkVersionStatus;
  @ApiProperty({
    type: ArtworkAssetDto,
    description:
      'File metadata. Use GET /admin/assets/:id/download-url for a private link.',
  })
  asset!: ArtworkAssetDto;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) rejectionReason!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) approvedAt!: Date | null;
  @ApiProperty({ nullable: true }) rejectedAt!: Date | null;
  @ApiProperty({ nullable: true }) supersededAt!: Date | null;
}

export class ArtworkResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) brandId!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) sampleId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ArtworkPurpose }) purpose!: ArtworkPurpose;
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description:
      'The single APPROVED version, if any (the production-facing one)',
  })
  approvedVersionId!: string | null;
  @ApiProperty({
    type: [ArtworkVersionResponseDto],
    description: 'Newest first',
  })
  versions!: ArtworkVersionResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedArtworksDto {
  @ApiProperty({ type: [ArtworkResponseDto] }) data!: ArtworkResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
