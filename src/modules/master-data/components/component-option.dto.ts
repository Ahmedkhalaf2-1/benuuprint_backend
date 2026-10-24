import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import {
  CodeField,
  NameField,
  NullableText,
  OptBool,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { ComponentCategory } from '../../../generated/prisma/client.js';
import { MasterDataListQueryDto } from '../master-data.base.js';

export class ListComponentOptionsQueryDto extends MasterDataListQueryDto {
  @ApiPropertyOptional({ enum: ComponentCategory })
  @IsOptional()
  @IsEnum(ComponentCategory)
  category?: ComponentCategory;
}

export class CreateComponentOptionDto {
  @ApiProperty({ enum: ComponentCategory })
  @IsEnum(ComponentCategory)
  category!: ComponentCategory;
  @CodeField('NECK_LABEL') code!: string;
  @NameField() name!: string;
  @OptText(1000) description?: string;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class UpdateComponentOptionDto {
  @ApiPropertyOptional({ enum: ComponentCategory })
  @IsOptional()
  @IsEnum(ComponentCategory)
  category?: ComponentCategory;
  @OptText(120) name?: string;
  @NullableText(1000) description?: string | null;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class ComponentOptionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ComponentCategory }) category!: ComponentCategory;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedComponentOptionsDto {
  @ApiProperty({ type: [ComponentOptionResponseDto] })
  data!: ComponentOptionResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
