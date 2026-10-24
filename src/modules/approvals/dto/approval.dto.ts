import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/transforms.js';
import {
  ApprovalMode,
  ApprovalStatus,
  ApprovalType,
} from '../../../generated/prisma/client.js';

export class RequestApprovalDto {
  @ApiProperty({ enum: ApprovalType })
  @IsEnum(ApprovalType)
  type!: ApprovalType;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required for type QUOTATION: a SENT quotation version of this sample',
  })
  @IsOptional()
  @IsUUID()
  quotationVersionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required for type ARTWORK: a DRAFT version of an artwork this sample can use',
  })
  @IsOptional()
  @IsUUID()
  artworkVersionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required for type PRODUCTION_SPEC: a frozen specification of this sample',
  })
  @IsOptional()
  @IsUUID()
  productionSpecId?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601; after this the request can no longer be answered',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}

export const RECORDED_AS = ['ON_BEHALF_OF_CUSTOMER', 'INTERNAL'] as const;
export type RecordedAs = (typeof RECORDED_AS)[number];

export class RespondApprovalDto {
  @ApiPropertyOptional({
    enum: RECORDED_AS,
    default: 'ON_BEHALF_OF_CUSTOMER',
    description:
      'ON_BEHALF_OF_CUSTOMER: staff record a decision the customer communicated (a source note is required). INTERNAL: an internal sign-off (not allowed for quotations or the sample approval). Authenticated customer decisions will arrive with the customer portal.',
  })
  @IsOptional()
  @IsIn(RECORDED_AS)
  recordedAs?: RecordedAs;

  @ApiPropertyOptional({
    description:
      'Evidence of the customer\'s decision (e.g. "WhatsApp, 21 Oct 14:05"). Required when recording on behalf of a customer.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  sourceNote?: string;

  @ApiPropertyOptional({
    description: 'Comment / reason. Required when rejecting a sample.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  responseNote?: string;
}

export class ApprovalResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ApprovalType }) type!: ApprovalType;
  @ApiProperty({ format: 'uuid' }) sampleId!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) quotationVersionId!:
    string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) artworkVersionId!:
    string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) productionSpecId!:
    string | null;
  @ApiProperty({ enum: ApprovalStatus }) status!: ApprovalStatus;
  @ApiProperty({ enum: ApprovalMode, nullable: true })
  mode!: ApprovalMode | null;
  @ApiProperty({
    description:
      'True when staff recorded the decision (every decision today); never a customer-authenticated one',
  })
  staffRecorded!: boolean;
  @ApiProperty({ format: 'uuid', nullable: true })
  requestedByUserId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true })
  requestedByCustomerId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true })
  respondedByCustomerId!: string | null;
  @ApiProperty() requestedAt!: Date;
  @ApiProperty({ nullable: true }) expiresAt!: Date | null;
  @ApiProperty({ nullable: true }) respondedAt!: Date | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) respondedByUserId!:
    string | null;
  @ApiProperty({ nullable: true }) responseNote!: string | null;
  @ApiProperty({ nullable: true }) sourceNote!: string | null;
  @ApiProperty() createdAt!: Date;
}
