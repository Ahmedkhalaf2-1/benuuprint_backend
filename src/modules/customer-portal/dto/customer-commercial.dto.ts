import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/transforms.js';
import { PaymentMethod } from '../../../generated/prisma/client.js';
import {
  CUSTOMER_ACTIONS,
  type CustomerAction,
  type CustomerPaymentStatus,
  type CustomerProofState,
} from '../commercial/customer-commercial.js';

// ---- quotation ---------------------------------------------------------------------------------

export class CustomerQuotationLineDto {
  @ApiProperty() type!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '10.00' }) quantity!: string;
  @ApiProperty({ example: '25.00' }) unitPrice!: string;
  @ApiProperty({ example: '250.00' }) amount!: string;
}

export class CustomerQuotationVersionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({
    enum: ['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'],
    description: 'Drafts are never shown to customers',
  })
  status!: string;
  @ApiProperty({
    description: 'The newest version of its quotation (older ones are history)',
  })
  isCurrent!: boolean;
  @ApiProperty({
    description:
      'You can accept or reject this version now (it is the open, unexpired offer)',
  })
  actionable!: boolean;
  @ApiProperty({
    description:
      'An order change made this version obsolete (orders only); it no longer applies',
  })
  endedByChange!: boolean;
  @ApiProperty({ example: 'EGP' }) currency!: string;
  @ApiProperty({ type: [CustomerQuotationLineDto] })
  lineItems!: CustomerQuotationLineDto[];
  @ApiProperty({ example: '300.00' }) subtotal!: string;
  @ApiProperty({ example: '0.00' }) discount!: string;
  @ApiProperty({ example: '14.00' }) taxPercent!: string;
  @ApiProperty({ example: '42.00' }) tax!: string;
  @ApiProperty({ example: '342.00' }) total!: string;
  @ApiProperty({ nullable: true }) validUntil!: Date | null;
  @ApiProperty({ nullable: true }) sentAt!: Date | null;
  @ApiProperty({ nullable: true }) acceptedAt!: Date | null;
  @ApiProperty({ nullable: true }) rejectedAt!: Date | null;
  @ApiProperty({ nullable: true }) supersededAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'The note printed for you on the quotation',
  })
  notes!: string | null;
}

export class CustomerQuotationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'QTN-000001' }) quotationNumber!: string;
  @ApiProperty({ example: 'EGP' }) currency!: string;
  @ApiProperty({
    enum: ['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'],
  })
  status!: string;
  @ApiProperty({ type: [CustomerQuotationVersionDto] })
  versions!: CustomerQuotationVersionDto[];
}

export class CustomerQuotationsDto {
  @ApiProperty({ type: [CustomerQuotationDto] })
  quotations!: CustomerQuotationDto[];
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'The version you can accept or reject now, if any',
  })
  actionableVersionId!: string | null;
  @ApiProperty({
    description:
      'True when you are being asked to decide again on a newer quotation',
  })
  requiresReview!: boolean;
  @ApiProperty({
    nullable: true,
    example: 'A new quotation requires your review.',
  })
  notice!: string | null;
}

export class RejectQuotationDto {
  @ApiPropertyOptional({ description: 'Why you are declining (optional)' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

// ---- payments ----------------------------------------------------------------------------------

export class CustomerPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'PAY-000001' }) paymentNumber!: string;
  @ApiProperty({ example: '500.00' }) amount!: string;
  @ApiProperty({ example: 'EGP' }) currency!: string;
  @ApiProperty({ enum: PaymentMethod }) method!: string;
  @ApiProperty({
    enum: ['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'CANCELLED'],
  })
  status!: CustomerProofState;
  @ApiProperty({ nullable: true }) transactionReference!: string | null;
  @ApiProperty({ nullable: true }) proofFileName!: string | null;
  @ApiProperty() hasProof!: boolean;
  @ApiProperty({ nullable: true }) receivedAt!: Date | null;
  @ApiProperty() submittedAt!: Date;
  @ApiProperty({ nullable: true }) verifiedAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description:
      'Only text our team wrote for you when a payment could not be verified',
  })
  message!: string | null;
  @ApiProperty({
    description:
      'You can still replace the proof (not yet picked up by our team)',
  })
  canReplaceProof!: boolean;
}

export class CustomerPaymentSummaryDto {
  @ApiProperty({
    enum: [
      'NOT_REQUIRED_YET',
      'PAYMENT_REQUIRED',
      'PAYMENT_UNDER_REVIEW',
      'PAID',
    ],
  })
  status!: CustomerPaymentStatus;
  @ApiProperty({ nullable: true, example: 'EGP' }) currency!: string | null;
  @ApiProperty({ nullable: true, example: '342.00' })
  requiredAmount!: string | null;
  @ApiProperty({ example: '0.00' }) verifiedAmount!: string;
  @ApiProperty({
    example: '0.00',
    description: 'Submitted by you and waiting for verification',
  })
  pendingAmount!: string;
  @ApiProperty({ nullable: true, example: '342.00' })
  remainingAmount!: string | null;
}

export class CustomerPaymentsDto {
  @ApiProperty({ type: CustomerPaymentSummaryDto })
  summary!: CustomerPaymentSummaryDto;
  @ApiProperty({ type: [CustomerPaymentDto] }) payments!: CustomerPaymentDto[];
}

/** multipart/form-data: the proof file plus these fields. */
export class CustomerSubmitPaymentDto {
  @ApiProperty({
    example: 500,
    description:
      'Greater than 0, up to 2 decimals; cannot exceed the remaining balance (the currency is the quotation currency)',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(9_999_999_999.99)
  amount!: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({
    description:
      'Transfer / receipt reference. Never enter card numbers: values that look like one are rejected.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  transactionReference?: string;

  @ApiPropertyOptional({ description: 'When you paid (ISO-8601)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  receivedAt?: Date;
}

// ---- commercial summary / production -------------------------------------------------------------

export class CustomerCommercialQuotationDto {
  @ApiProperty({ format: 'uuid' }) quotationId!: string;
  @ApiProperty({ example: 'QTN-000001' }) quotationNumber!: string;
  @ApiProperty({ format: 'uuid' }) versionId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ enum: ['SENT', 'ACCEPTED'] }) status!: string;
  @ApiProperty({ example: '342.00' }) total!: string;
  @ApiProperty({ example: 'EGP' }) currency!: string;
  @ApiProperty({ nullable: true }) validUntil!: Date | null;
  @ApiProperty() requiresReview!: boolean;
}

export class CustomerCommercialSummaryDto {
  @ApiProperty({ format: 'uuid' }) sampleId!: string;
  @ApiProperty({ type: CustomerCommercialQuotationDto, nullable: true })
  quotation!: CustomerCommercialQuotationDto | null;
  @ApiProperty({ type: CustomerPaymentSummaryDto })
  payment!: CustomerPaymentSummaryDto;
  @ApiProperty({
    enum: ['REVIEW_QUOTATION', 'PAY', 'REVIEW_SAMPLE', 'NONE'],
  })
  nextAction!: string;
  @ApiProperty({ enum: CUSTOMER_ACTIONS, isArray: true })
  allowedActions!: CustomerAction[];
}

export class CustomerProductionStepDto {
  @ApiProperty({
    enum: [
      'PREPARING_MATERIALS',
      'PATTERN_AND_CUTTING',
      'DECORATION',
      'SEWING',
      'QUALITY_CHECK',
      'SAMPLE_READY',
    ],
  })
  code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['PENDING', 'ACTIVE', 'DONE'] }) state!: string;
}

export class CustomerProductionDto {
  @ApiProperty({ enum: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'] })
  phase!: string;
  @ApiProperty({ type: [CustomerProductionStepDto] })
  steps!: CustomerProductionStepDto[];
}

// ---- sample approval -----------------------------------------------------------------------------

export const CHANGE_CATEGORIES = [
  'FIT',
  'FABRIC',
  'COLOUR',
  'ARTWORK',
  'DECORATION',
  'CONSTRUCTION',
  'OTHER',
] as const;

export class ApproveSampleDto {
  @ApiPropertyOptional({
    description: 'An optional comment with your approval',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RequestSampleChangesDto {
  @ApiProperty({
    description: 'What you would like changed',
    minLength: 3,
    maxLength: 2000,
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;

  @ApiPropertyOptional({ enum: CHANGE_CATEGORIES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsIn(CHANGE_CATEGORIES, { each: true })
  categories?: (typeof CHANGE_CATEGORIES)[number][];
}
