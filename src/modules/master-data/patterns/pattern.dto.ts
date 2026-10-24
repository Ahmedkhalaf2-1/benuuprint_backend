import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  CodeField,
  NameField,
  NullableText,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean } from '../../../common/transforms.js';
import {
  PatternStatus,
  PatternVersionStatus,
} from '../../../generated/prisma/client.js';

export class ListPatternsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Matches code, reference number or name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productTypeId?: string;

  @ApiPropertyOptional({ enum: PatternStatus })
  @IsOptional()
  @IsEnum(PatternStatus)
  status?: PatternStatus;

  @ApiPropertyOptional({ description: 'Include archived patterns' })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;
}

export class CreatePatternDto {
  @CodeField('TEE_REGULAR') code!: string;
  @NameField() name!: string;
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productTypeId!: string;
  @OptText(2000) description?: string;
  @ApiPropertyOptional({ example: 'OVERSIZED' }) @OptText(50) fitType?: string;
  @OptText(2000) notes?: string;
  @ApiPropertyOptional({ description: 'Notes for the initial DRAFT version 1' })
  @OptText(2000)
  versionNotes?: string;
}

export class UpdatePatternDto {
  @OptText(120) name?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only while no version has been approved',
  })
  @IsOptional()
  @IsUUID()
  productTypeId?: string;
  @NullableText(2000) description?: string | null;
  @NullableText(50) fitType?: string | null;
  @NullableText(2000) notes?: string | null;
}

export class CreatePatternVersionDto {
  @OptText(2000) notes?: string;
}

export class UpdatePatternVersionDto {
  @NullableText(2000) notes?: string | null;
}

export class PatternProductTypeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class PatternVersionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patternId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ enum: PatternVersionStatus }) status!: PatternVersionStatus;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) approvedAt!: Date | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) approvedByUserId!:
    string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) createdByUserId!:
    string | null;
  @ApiProperty() createdAt!: Date;
}

export class PatternResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'PAT-000001' }) referenceNumber!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: PatternProductTypeDto })
  productType!: PatternProductTypeDto;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) fitType!: string | null;
  @ApiProperty({ enum: PatternStatus }) status!: PatternStatus;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description: 'The approved version new work should use',
  })
  currentVersionId!: string | null;
  @ApiProperty({ nullable: true }) currentVersionNumber!: number | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class PatternDetailResponseDto extends PatternResponseDto {
  @ApiProperty({
    type: [PatternVersionResponseDto],
    description: 'Newest first',
  })
  versions!: PatternVersionResponseDto[];
}

export class PaginatedPatternsDto {
  @ApiProperty({ type: [PatternResponseDto] }) data!: PatternResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
