import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import {
  NormalizeHandle,
  NormalizePhone,
  Trim,
} from '../../../common/transforms.js';
import { NullableOptional } from '../../../common/decorators/validation.decorators.js';
import { PHONE_PATTERN } from '../../customers/dto/customer.dto.js';
import { CreateBrandDto, UpdateBrandDto } from '../../brands/dto/brand.dto.js';

const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export class CustomerProfileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUS-000001' }) customerNumber!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Your login email' }) email!: string;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) whatsapp!: string | null;
  @ApiProperty({ nullable: true }) country!: string | null;
  @ApiProperty({ nullable: true }) city!: string | null;
  @ApiProperty({ nullable: true }) instagram!: string | null;
  @ApiProperty({ nullable: true, example: 'en' })
  preferredLocale!: string | null;
}

/** Name and login email are identity fields: staff change them, customers cannot. */
export class UpdateCustomerProfileDto {
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, {
    message: 'phone must be 6-15 digits, optionally starting with +',
  })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, {
    message: 'whatsapp must be 6-15 digits, optionally starting with +',
  })
  whatsapp?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  country?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizeHandle()
  @Matches(HANDLE_PATTERN, { message: 'instagram must be a valid handle' })
  instagram?: string | null;

  @ApiPropertyOptional({ enum: ['en', 'ar'] })
  @NullableOptional()
  @IsIn(['en', 'ar'])
  preferredLocale?: string | null;
}

export class CustomerBrandDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BRD-000001' }) brandNumber!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) instagram!: string | null;
  @ApiProperty({ nullable: true }) website!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) primaryColor!: string | null;
  @ApiProperty({ nullable: true }) secondaryColor!: string | null;
}

/**
 * What a customer may send for their own brand: the public brand fields only. `status` (and anything
 * else, e.g. customerId, notes, archive state) is rejected by the global whitelist validation.
 */
export class CustomerCreateBrandDto extends OmitType(CreateBrandDto, [
  'status',
] as const) {}

export class CustomerUpdateBrandDto extends OmitType(UpdateBrandDto, [
  'status',
] as const) {}
