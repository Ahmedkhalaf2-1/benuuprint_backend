import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  NullableOptional,
  NullableText,
  OptInt,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { Trim } from '../../../common/transforms.js';
import {
  QuotationLineType,
  QuotationStatus,
} from '../../../generated/prisma/client.js';

const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };

export class QuotationLineItemDto {
  @ApiProperty({ enum: QuotationLineType, example: QuotationLineType.PRINTING })
  @IsEnum(QuotationLineType)
  type!: QuotationLineType;

  @ApiProperty({ example: 'DTF print, chest 25x10 cm' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  description!: string;

  @ApiProperty({ example: 1, description: 'Greater than 0, up to 2 decimals' })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100000)
  quantity!: number;

  @ApiProperty({
    example: 150,
    description:
      'Price per unit, up to 2 decimals. Only DISCOUNT_ADJUSTMENT lines may be negative.',
  })
  @IsNumber(MONEY)
  @Min(-9_999_999_999.99)
  @Max(9_999_999_999.99)
  unitPrice!: number;

  @OptInt(0, 10000) sortOrder?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Free-form structured detail for future pricing rules',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

const validUntil = () =>
  ApiPropertyOptional({
    description: 'ISO-8601; the offer cannot be accepted after this moment',
  });

export class CreateQuotationDto {
  @ApiPropertyOptional({
    example: 'EGP',
    description: 'ISO 4217; defaults to the configured DEFAULT_CURRENCY',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a 3-letter uppercase ISO code',
  })
  currency?: string;

  @ApiPropertyOptional({ type: [QuotationLineItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuotationLineItemDto)
  lineItems?: QuotationLineItemDto[];

  @ApiPropertyOptional({
    example: 0,
    description: 'Absolute discount amount (not a percentage)',
  })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(9_999_999_999.99)
  discount?: number;

  @ApiPropertyOptional({
    example: 14,
    description:
      'Tax percentage 0–100; the tax amount is calculated by the server',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  taxPercent?: number;

  @OptText(2000) notes?: string;
  @ApiPropertyOptional({
    description:
      'Printed for the customer on the quotation (the only free text they see). `notes` stays internal.',
  })
  @OptText(2000)
  customerNotes?: string;

  @validUntil() @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
}

export class CreateQuotationVersionDto {
  @ApiPropertyOptional({
    type: [QuotationLineItemDto],
    description: "Omit to start from the previous version's lines",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuotationLineItemDto)
  lineItems?: QuotationLineItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(9_999_999_999.99)
  discount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  taxPercent?: number;
  @OptText(2000) notes?: string;
  @ApiPropertyOptional({
    description:
      'Printed for the customer on the quotation (the only free text they see). `notes` stays internal.',
  })
  @OptText(2000)
  customerNotes?: string;
  @validUntil() @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
}

/** PATCH of a DRAFT version. lineItems, when given, replaces the full list. */
export class UpdateQuotationVersionDto {
  @ApiPropertyOptional({ type: [QuotationLineItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuotationLineItemDto)
  lineItems?: QuotationLineItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(9_999_999_999.99)
  discount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  taxPercent?: number;
  @NullableText(2000) notes?: string | null;
  @NullableText(2000) customerNotes?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  @IsDate()
  validUntil?: Date | null;
}

export class DecisionDto {
  @ApiProperty({
    description:
      'Evidence of the customer\'s decision, e.g. "Confirmed by WhatsApp 21 Oct 14:05". Required: staff are recording a decision made by the customer.',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  sourceNote!: string;

  @ApiPropertyOptional({
    description: "Customer's comment / reason (recommended when rejecting)",
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  responseNote?: string;
}

export class QuotationLineItemResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: QuotationLineType }) type!: QuotationLineType;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '2.00' }) quantity!: string;
  @ApiProperty({ example: '150.00' }) unitPrice!: string;
  @ApiProperty({
    example: '300.00',
    description: 'quantity × unitPrice, calculated by the server',
  })
  amount!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown> | null;
}

export class QuotationVersionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) quotationId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ enum: QuotationStatus }) status!: QuotationStatus;
  @ApiProperty({ example: 'EGP' }) currency!: string;
  @ApiProperty({ example: '300.00' }) subtotal!: string;
  @ApiProperty({ example: '0.00' }) discount!: string;
  @ApiProperty({ example: '14.00' }) taxPercent!: string;
  @ApiProperty({ example: '42.00' }) tax!: string;
  @ApiProperty({ example: '342.00' }) total!: string;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) customerNotes!: string | null;
  @ApiProperty({ nullable: true }) validUntil!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) sentAt!: Date | null;
  @ApiProperty({ nullable: true }) acceptedAt!: Date | null;
  @ApiProperty({ nullable: true }) rejectedAt!: Date | null;
  @ApiProperty({ nullable: true }) expiredAt!: Date | null;
  @ApiProperty({ nullable: true }) supersededAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'Orders: the order revision this version priced',
  })
  orderRevision!: number | null;
  @ApiProperty({
    nullable: true,
    description:
      'Set when a commercially relevant order revision ended this version (terms and decision are kept)',
  })
  invalidatedAt!: Date | null;
  @ApiProperty({ nullable: true }) invalidatedByRevision!: number | null;
  @ApiProperty({ nullable: true }) invalidationReason!: string | null;
  @ApiProperty({ type: [QuotationLineItemResponseDto] })
  lineItems!: QuotationLineItemResponseDto[];
}

export class QuotationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'QTN-000001' }) quotationNumber!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) sampleId!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) orderId!: string | null;
  @ApiProperty({
    enum: QuotationStatus,
    description: 'Mirrors the live (latest) version',
  })
  status!: QuotationStatus;
  @ApiProperty({ example: 'EGP' }) currency!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({
    type: QuotationVersionResponseDto,
    description: 'The latest version',
  })
  currentVersion!: QuotationVersionResponseDto;
  @ApiProperty({
    type: [QuotationVersionResponseDto],
    description: 'Full history, newest first',
  })
  versions!: QuotationVersionResponseDto[];
}
