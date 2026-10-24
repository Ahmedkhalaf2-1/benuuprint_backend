import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import {
  CodeField,
  NameField,
  NullableMoney,
  NullableText,
  OptBool,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { ProductCategory } from '../../../generated/prisma/client.js';
import { MasterDataListQueryDto } from '../master-data.base.js';

export class ListProductTypesQueryDto extends MasterDataListQueryDto {
  @ApiPropertyOptional({ enum: ProductCategory })
  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;
}

export class CreateProductTypeDto {
  @CodeField('HOODIE') code!: string;
  @NameField() name!: string;
  @OptText(1000) description?: string;
  @ApiPropertyOptional({ enum: ProductCategory })
  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
  @NullableMoney() defaultSampleFee?: number | null;
}

export class UpdateProductTypeDto {
  @OptText(120) name?: string;
  @NullableText(1000) description?: string | null;
  @ApiPropertyOptional({ enum: ProductCategory, nullable: true })
  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
  @NullableMoney() defaultSampleFee?: number | null;
}

export class ProductTypeResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ProductCategory, nullable: true })
  category!: ProductCategory | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ nullable: true, type: String, example: '150.00' })
  defaultSampleFee!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedProductTypesDto {
  @ApiProperty({ type: [ProductTypeResponseDto] })
  data!: ProductTypeResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
