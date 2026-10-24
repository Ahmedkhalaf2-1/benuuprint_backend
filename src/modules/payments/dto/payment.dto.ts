import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  NullableOptional,
  NullableUuid,
} from '../../../common/decorators/validation.decorators.js';
import { Trim } from '../../../common/transforms.js';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../../generated/prisma/client.js';

const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };

export class CreatePaymentDto {
  @ApiProperty({
    example: 500,
    description:
      'Greater than 0, up to 2 decimals; cannot exceed the remaining balance',
  })
  @IsNumber(MONEY)
  @Min(0.01)
  @Max(9_999_999_999.99)
  amount!: number;

  @ApiPropertyOptional({
    example: 'EGP',
    description: 'Must match the quotation currency; defaults to it',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a 3-letter uppercase ISO code',
  })
  currency?: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({
    description:
      'Transfer/receipt reference. Never enter card numbers: values that look like one are rejected.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  transactionReference?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Proof file: an asset of type PAYMENT_PROOF, used by this payment only',
  })
  @IsOptional()
  @IsUUID()
  proofAssetId?: string;

  @ApiPropertyOptional({
    description: 'When the money was received (ISO-8601)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  receivedAt?: Date;
}

/** PATCH of a payment that has not been decided yet (SUBMITTED). */
export class UpdatePaymentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0.01)
  @Max(9_999_999_999.99)
  amount?: number;
  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  transactionReference?: string | null;
  @NullableUuid() proofAssetId?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Type(() => Date)
  @IsDate()
  receivedAt?: Date | null;
}

export class RejectPaymentDto {
  @ApiProperty({ description: 'Why the payment could not be verified' })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'Optional text shown to the customer in the portal and in their notification. The internal `reason` is never shown to them.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  customerMessage?: string;
}

export class PaymentProofDto {
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty() originalName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
}

export class PaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'PAY-000001' }) paymentNumber!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) sampleId!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) orderId!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) quotationVersionId!:
    string | null;
  @ApiProperty({ example: '500.00' }) amount!: string;
  @ApiProperty({ example: 'EGP' }) currency!: string;
  @ApiProperty({ enum: PaymentMethod }) method!: PaymentMethod;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiProperty({ nullable: true }) transactionReference!: string | null;
  @ApiProperty({
    type: PaymentProofDto,
    nullable: true,
    description:
      'Metadata only; use the asset download-url endpoint for a private link',
  })
  proof!: PaymentProofDto | null;
  @ApiProperty({ nullable: true }) receivedAt!: Date | null;
  @ApiProperty({ nullable: true }) verifiedAt!: Date | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) verifiedByUserId!:
    string | null;
  @ApiProperty({ nullable: true }) rejectionReason!: string | null;
  @ApiProperty({ nullable: true }) customerMessage!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' })
  createdByCustomerId!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) createdByUserId!:
    string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
