import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CodeField,
  NameField,
  NullableInt,
  NullableOptional,
  NullableText,
  OptBool,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import { MasterDataListQueryDto } from '../master-data.base.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class ListFabricsQueryDto extends MasterDataListQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only fabrics allowed for this product type',
  })
  @IsOptional()
  @IsUUID()
  productTypeId?: string;
}

export class CreateFabricDto {
  @CodeField('FRENCH_TERRY') code!: string;
  @NameField() name!: string;
  @OptText(2000) description?: string;
  @OptText(200) composition?: string;
  @NullableInt(1, 2000) minGsm?: number | null;
  @NullableInt(1, 2000) maxGsm?: number | null;
  @NullableInt(1, 2000) defaultGsm?: number | null;
  @ApiPropertyOptional({ example: 'KG' }) @OptText(20) unit?: string;
  @OptText(2000) notes?: string;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class UpdateFabricDto {
  @OptText(120) name?: string;
  @NullableText(2000) description?: string | null;
  @NullableText(200) composition?: string | null;
  @NullableInt(1, 2000) minGsm?: number | null;
  @NullableInt(1, 2000) maxGsm?: number | null;
  @NullableInt(1, 2000) defaultGsm?: number | null;
  @NullableText(20) unit?: string | null;
  @NullableText(2000) notes?: string | null;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class FabricColorSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) hex!: string | null;
  @ApiProperty() isAvailable!: boolean;
}

export class FabricProductTypeDto {
  @ApiProperty({ format: 'uuid' }) productTypeId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isRecommended!: boolean;
  @ApiProperty() isAllowed!: boolean;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class FabricResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'FAB-000001' }) referenceNumber!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) composition!: string | null;
  @ApiProperty({ nullable: true }) minGsm!: number | null;
  @ApiProperty({ nullable: true }) maxGsm!: number | null;
  @ApiProperty({ nullable: true }) defaultGsm!: number | null;
  @ApiProperty({ nullable: true }) unit!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({
    type: [FabricColorSummaryDto],
    description: 'Live (non-archived) colours',
  })
  colors!: FabricColorSummaryDto[];
  @ApiProperty({ type: [FabricProductTypeDto] })
  productTypes!: FabricProductTypeDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedFabricsDto {
  @ApiProperty({ type: [FabricResponseDto] }) data!: FabricResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class CreateFabricColorDto {
  @NameField(80) name!: string;
  @OptText(40) internalCode?: string;
  @ApiPropertyOptional({ example: '#1A2B3C' })
  @IsOptional()
  @Matches(HEX, { message: 'hex must be a colour like #1A2B3C' })
  hex?: string;
  @OptText(30) pantone?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Asset of type FABRIC_SWATCH',
  })
  @IsOptional()
  @IsUUID()
  swatchAssetId?: string;
  @OptBool() isAvailable?: boolean;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class UpdateFabricColorDto {
  @OptText(80) name?: string;
  @NullableText(40) internalCode?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Matches(HEX, { message: 'hex must be a colour like #1A2B3C' })
  hex?: string | null;
  @NullableText(30) pantone?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  @NullableOptional()
  @IsUUID()
  swatchAssetId?: string | null;
  @OptBool() isAvailable?: boolean;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class ListFabricColorsQueryDto {
  @ApiPropertyOptional({ description: 'Include archived colours' })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;
}

export class FabricColorResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) fabricId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) internalCode!: string | null;
  @ApiProperty({ nullable: true }) hex!: string | null;
  @ApiProperty({ nullable: true }) pantone!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) swatchAssetId!:
    string | null;
  @ApiProperty() isAvailable!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class SetProductFabricDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Benue Print recommends this fabric for the product',
  })
  @IsOptional()
  @IsBoolean()
  isRecommended?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'false = discouraged/not offered, but never a hard block elsewhere',
  })
  @IsOptional()
  @IsBoolean()
  isAllowed?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class ProductFabricResponseDto {
  @ApiProperty({ format: 'uuid' }) productTypeId!: string;
  @ApiProperty({ format: 'uuid' }) fabricId!: string;
  @ApiProperty() fabricCode!: string;
  @ApiProperty() fabricName!: string;
  @ApiProperty() isRecommended!: boolean;
  @ApiProperty() isAllowed!: boolean;
  @ApiProperty({ nullable: true }) notes!: string | null;
}
