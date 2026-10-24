import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NullableOptional } from '../../../common/decorators/validation.decorators.js';
import {
  NormalizeEmail,
  NormalizePhone,
  Trim,
} from '../../../common/transforms.js';
import { AddressType, ContactRole } from '../../../generated/prisma/client.js';
import { PHONE_PATTERN } from './customer.dto.js';

export class CreateContactDto {
  @ApiPropertyOptional({ enum: ContactRole, default: ContactRole.OTHER })
  @IsOptional()
  @IsEnum(ContactRole)
  role?: ContactRole;

  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, {
    message: 'phone must be 6-15 digits, optionally starting with +',
  })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, {
    message: 'whatsapp must be 6-15 digits, optionally starting with +',
  })
  whatsapp?: string;

  @ApiPropertyOptional({
    description: "Setting true demotes the customer's previous primary contact",
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateContactDto {
  @ApiPropertyOptional({ enum: ContactRole })
  @IsOptional()
  @IsEnum(ContactRole)
  role?: ContactRole;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  jobTitle?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class CreateAddressDto {
  @ApiPropertyOptional({ enum: AddressType, default: AddressType.SHIPPING })
  @IsOptional()
  @IsEnum(AddressType)
  type?: AddressType;

  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  country!: string;

  @ApiPropertyOptional({ description: 'Governorate / state' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  state?: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  area?: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  addressLine1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Setting true demotes the previous default of the same type',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional({ enum: AddressType })
  @IsOptional()
  @IsEnum(AddressType)
  type?: AddressType;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  country?: string;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  state?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  area?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  addressLine2?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(20)
  postalCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
