import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import {
  CodeField,
  NameField,
  NullableInt,
  NullableMoney,
  NullableText,
  OptBool,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PrintMethodType } from '../../../generated/prisma/client.js';
import { MasterDataListQueryDto } from '../master-data.base.js';

export class ListPrintMethodsQueryDto extends MasterDataListQueryDto {
  @ApiPropertyOptional({ enum: PrintMethodType })
  @IsOptional()
  @IsEnum(PrintMethodType)
  type?: PrintMethodType;
}

export class CreatePrintMethodDto {
  @CodeField('SCREEN_PRINT') code!: string;
  @NameField() name!: string;
  @ApiPropertyOptional({
    enum: PrintMethodType,
    default: PrintMethodType.PRINT,
  })
  @IsOptional()
  @IsEnum(PrintMethodType)
  type?: PrintMethodType;
  @OptText(1000) description?: string;
  @NullableInt(0, 1000000) minQuantity?: number | null;
  @NullableInt(1, 100) maxColors?: number | null;
  @OptBool() supportsFullColor?: boolean;
  @NullableMoney() setupFee?: number | null;
  @OptText(2000) notes?: string;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class UpdatePrintMethodDto {
  @OptText(120) name?: string;
  @ApiPropertyOptional({ enum: PrintMethodType })
  @IsOptional()
  @IsEnum(PrintMethodType)
  type?: PrintMethodType;
  @NullableText(1000) description?: string | null;
  @NullableInt(0, 1000000) minQuantity?: number | null;
  @NullableInt(1, 100) maxColors?: number | null;
  @OptBool() supportsFullColor?: boolean;
  @NullableMoney() setupFee?: number | null;
  @NullableText(2000) notes?: string | null;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class PrintMethodResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PrintMethodType }) type!: PrintMethodType;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) minQuantity!: number | null;
  @ApiProperty({ nullable: true }) maxColors!: number | null;
  @ApiProperty() supportsFullColor!: boolean;
  @ApiProperty({ nullable: true, type: String, example: '250.00' }) setupFee!:
    string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedPrintMethodsDto {
  @ApiProperty({ type: [PrintMethodResponseDto] })
  data!: PrintMethodResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
