import { ApiProperty } from '@nestjs/swagger';
import {
  CodeField,
  NameField,
  NullableText,
  OptBool,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';

export class CreateSizeScaleDto {
  @CodeField('STANDARD') code!: string;
  @NameField() name!: string;
  @OptText(500) description?: string;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class UpdateSizeScaleDto {
  @OptText(120) name?: string;
  @NullableText(500) description?: string | null;
  @OptBool() isActive?: boolean;
  @OptInt(0, 100000) sortOrder?: number;
}

export class CreateSizeOptionDto {
  @CodeField('XL') code!: string;
  @NameField(50) name!: string;
  @OptInt(0, 100000) sortOrder?: number;
  @OptBool() isActive?: boolean;
}

export class UpdateSizeOptionDto {
  @OptText(50) name?: string;
  @OptInt(0, 100000) sortOrder?: number;
  @OptBool() isActive?: boolean;
}

export class SizeOptionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) scaleId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class SizeScaleResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({
    type: [SizeOptionResponseDto],
    description: 'Live sizes in display order',
  })
  sizes!: SizeOptionResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PaginatedSizeScalesDto {
  @ApiProperty({ type: [SizeScaleResponseDto] }) data!: SizeScaleResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
