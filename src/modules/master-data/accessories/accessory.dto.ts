import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import {
  CodeField,
  NameField,
  NullableText,
  OptBool,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { MasterDataListQueryDto } from '../master-data.base.js';

export class ListAccessoriesQueryDto extends MasterDataListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;
}

export class CreateAccessoryDto {
  @CodeField('DRAWCORD') code!: string;
  @NameField() name!: string;
  @OptText(50) category?: string;
  @OptText(1000) description?: string;
  @OptText(20) unit?: string;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class UpdateAccessoryDto {
  @OptText(120) name?: string;
  @NullableText(50) category?: string | null;
  @NullableText(1000) description?: string | null;
  @NullableText(20) unit?: string | null;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class AccessoryResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) category!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) unit!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedAccessoriesDto {
  @ApiProperty({ type: [AccessoryResponseDto] }) data!: AccessoryResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
