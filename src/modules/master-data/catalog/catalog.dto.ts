import { ApiProperty } from '@nestjs/swagger';

/**
 * Slim, customer-safe projections for the future sample configurator:
 * active records only, no fees, internal notes, reference numbers or audit fields.
 */
export class CatalogProductTypeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) category!: string | null;
}

export class CatalogColorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) hex!: string | null;
  @ApiProperty({ nullable: true }) pantone!: string | null;
}

export class CatalogFabricProductDto {
  @ApiProperty({ format: 'uuid' }) productTypeId!: string;
  @ApiProperty() isRecommended!: boolean;
}

export class CatalogFabricDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) composition!: string | null;
  @ApiProperty({ nullable: true }) minGsm!: number | null;
  @ApiProperty({ nullable: true }) maxGsm!: number | null;
  @ApiProperty({ nullable: true }) defaultGsm!: number | null;
  @ApiProperty({
    type: [CatalogColorDto],
    description:
      'Available predefined colours (custom colours are always possible)',
  })
  colors!: CatalogColorDto[];
  @ApiProperty({
    type: [CatalogFabricProductDto],
    description: 'Product types this fabric is allowed for',
  })
  productTypes!: CatalogFabricProductDto[];
}

export class CatalogPrintMethodDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() supportsFullColor!: boolean;
  @ApiProperty({ nullable: true }) maxColors!: number | null;
  @ApiProperty({ nullable: true }) minQuantity!: number | null;
}

export class CatalogSizeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class CatalogSizeScaleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [CatalogSizeDto] }) sizes!: CatalogSizeDto[];
}
