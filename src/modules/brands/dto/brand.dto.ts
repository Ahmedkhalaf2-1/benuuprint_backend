import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NullableOptional } from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  NormalizeHandle,
  ToBoolean,
  Trim,
} from '../../../common/transforms.js';
import { BrandStatus } from '../../../generated/prisma/client.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
const HEX_MESSAGE = 'must be a hex colour like #1A2B3C';
const URL_OPTIONS = { protocols: ['http', 'https'], require_protocol: true };

export class ListBrandsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: BrandStatus })
  @IsOptional()
  @IsEnum(BrandStatus)
  status?: BrandStatus;

  @ApiPropertyOptional({
    description: 'Include ARCHIVED brands (excluded by default)',
  })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;
}

export class CreateBrandDto {
  @ApiProperty({ example: 'Nile Core' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @NormalizeHandle()
  @Matches(/^[A-Za-z0-9._]{1,30}$/, {
    message: 'instagram must be a valid handle',
  })
  instagram?: string;

  @ApiPropertyOptional({ example: 'https://example.com' })
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  @MaxLength(300)
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: '#112233' })
  @IsOptional()
  @Matches(HEX, { message: `primaryColor ${HEX_MESSAGE}` })
  primaryColor?: string;

  @ApiPropertyOptional({ example: '#FFFFFF' })
  @IsOptional()
  @Matches(HEX, { message: `secondaryColor ${HEX_MESSAGE}` })
  secondaryColor?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}

export class UpdateBrandDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizeHandle()
  @Matches(/^[A-Za-z0-9._]{1,30}$/, {
    message: 'instagram must be a valid handle',
  })
  instagram?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @IsUrl(URL_OPTIONS)
  @MaxLength(300)
  website?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Matches(HEX, { message: `primaryColor ${HEX_MESSAGE}` })
  primaryColor?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Matches(HEX, { message: `secondaryColor ${HEX_MESSAGE}` })
  secondaryColor?: string | null;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'INACTIVE'],
    description:
      'Setting a status on an archived brand restores it (if its customer is not archived)',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}

export class BrandCustomerDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUS-000001' }) customerNumber!: string;
  @ApiProperty() displayName!: string;
}

export class BrandResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BRD-000001' }) brandNumber!: string;
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) instagram!: string | null;
  @ApiProperty({ nullable: true }) website!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) primaryColor!: string | null;
  @ApiProperty({ nullable: true }) secondaryColor!: string | null;
  @ApiProperty({ enum: BrandStatus }) status!: BrandStatus;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
}

export class BrandDetailResponseDto extends BrandResponseDto {
  @ApiProperty({ type: BrandCustomerDto }) customer!: BrandCustomerDto;
}

export class PaginatedBrandsDto {
  @ApiProperty({ type: [BrandResponseDto] }) data!: BrandResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
