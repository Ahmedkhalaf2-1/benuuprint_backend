import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NullableOptional } from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  NormalizeEmail,
  NormalizeHandle,
  NormalizePhone,
  ToBoolean,
  Trim,
} from '../../../common/transforms.js';
import { CustomerStatus } from '../../../generated/prisma/client.js';

export const PHONE_PATTERN = /^\+?\d{6,15}$/;
const PHONE_MESSAGE =
  'must be a phone number with 6-15 digits, optionally starting with +';
const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export const CUSTOMER_SORT_FIELDS = [
  'createdAt',
  'displayName',
  'customerNumber',
] as const;

export class ListCustomersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Matches customer number, name, email, phone, WhatsApp or (active) brand name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: CustomerStatus })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiPropertyOptional({
    description: 'Include ARCHIVED customers (excluded by default)',
  })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;

  @ApiPropertyOptional({
    description:
      'Add responsibilitySummary, currentProcess, currentProcesses and activeJobCount to each customer, in a fixed number of queries. Needs responsibilities.read.',
  })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeOperations?: boolean;

  @ApiPropertyOptional({ enum: CUSTOMER_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(CUSTOMER_SORT_FIELDS)
  sortBy: (typeof CUSTOMER_SORT_FIELDS)[number] = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}

export class CreateCustomerDto {
  @ApiProperty({ example: 'Nile Streetwear' })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  displayName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    example: '+201001234567',
    description: 'Spaces, dashes and 00 prefix are normalised',
  })
  @IsOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, { message: `phone ${PHONE_MESSAGE}` })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, { message: `whatsapp ${PHONE_MESSAGE}` })
  whatsapp?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({
    example: 'nile.streetwear',
    description: 'Handle without @',
  })
  @IsOptional()
  @NormalizeHandle()
  @Matches(HANDLE_PATTERN, { message: 'instagram must be a valid handle' })
  instagram?: string;

  @ApiPropertyOptional({
    example: 'WhatsApp',
    description: 'How the customer found us',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'LEAD', 'INACTIVE', 'BLOCKED'],
    default: 'ACTIVE',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'LEAD', 'INACTIVE', 'BLOCKED'])
  status?: 'ACTIVE' | 'LEAD' | 'INACTIVE' | 'BLOCKED';
}

/** On update every optional field may be null to clear it. */
export class UpdateCustomerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  displayName?: string;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, { message: `phone ${PHONE_MESSAGE}` })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, { message: `whatsapp ${PHONE_MESSAGE}` })
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

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  source?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UpdateCustomerStatusDto {
  @ApiProperty({
    enum: ['ACTIVE', 'LEAD', 'INACTIVE', 'BLOCKED'],
    description:
      'Archive with DELETE. Setting a status on an archived customer restores it.',
  })
  @IsIn(['ACTIVE', 'LEAD', 'INACTIVE', 'BLOCKED'])
  status!: 'ACTIVE' | 'LEAD' | 'INACTIVE' | 'BLOCKED';
}

export class BrandSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BRD-000001' }) brandNumber!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
}

export class CustomerResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUS-000001' }) customerNumber!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) whatsapp!: string | null;
  @ApiProperty({ nullable: true }) country!: string | null;
  @ApiProperty({ nullable: true }) city!: string | null;
  @ApiProperty({ nullable: true }) instagram!: string | null;
  @ApiProperty({ nullable: true }) source!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ enum: CustomerStatus }) status!: CustomerStatus;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;

  @ApiPropertyOptional({
    description:
      'Only with includeOperations=true: sales owner, effective owner per area, configured count and whether any rule needs attention',
  })
  responsibilitySummary?: unknown;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Only with includeOperations=true: the highest-priority live work item (blocked, overdue, in progress, ready, planned)',
  })
  currentProcess?: unknown;
  @ApiPropertyOptional({
    description:
      'Only with includeOperations=true: up to 5 live work items in priority order',
  })
  currentProcesses?: unknown[];
  @ApiPropertyOptional({ description: 'Only with includeOperations=true' })
  activeJobCount?: number;
}

export class CustomerContactResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() role!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) jobTitle!: string | null;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) whatsapp!: string | null;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CustomerAddressResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() country!: string;
  @ApiProperty({ nullable: true }) state!: string | null;
  @ApiProperty() city!: string;
  @ApiProperty({ nullable: true }) area!: string | null;
  @ApiProperty() addressLine1!: string;
  @ApiProperty({ nullable: true }) addressLine2!: string | null;
  @ApiProperty({ nullable: true }) postalCode!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CustomerDetailResponseDto extends CustomerResponseDto {
  @ApiProperty({ type: [BrandSummaryDto], description: 'Non-archived brands' })
  brands!: BrandSummaryDto[];
  @ApiProperty({ type: [CustomerContactResponseDto] })
  contacts!: CustomerContactResponseDto[];
  @ApiProperty({ type: [CustomerAddressResponseDto] })
  addresses!: CustomerAddressResponseDto[];
}

export class PaginatedCustomersDto {
  @ApiProperty({ type: [CustomerResponseDto] }) data!: CustomerResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
