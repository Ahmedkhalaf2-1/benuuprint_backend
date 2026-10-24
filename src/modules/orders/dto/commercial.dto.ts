import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Trim } from '../../../common/transforms.js';
import { PaymentState } from '../../../generated/prisma/client.js';

export class RecordOrderDecisionDto {
  @ApiProperty({
    description:
      'Evidence of the customer\'s decision (e.g. "WhatsApp confirmation, 21 Oct 16:10")',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  sourceNote!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  responseNote?: string;
}

export class ReleaseGateDto {
  @ApiProperty() requireAcceptedQuotation!: boolean;
  @ApiProperty({
    description:
      'Share of the quotation total that must be verified (configured, default 100)',
  })
  requiredPaidPercent!: number;
  @ApiProperty({ nullable: true, example: '1000.00' }) requiredPaidAmount!:
    string | null;
  @ApiProperty({
    description: 'The commercial conditions for READY_FOR_PRODUCTION are met',
  })
  satisfied!: boolean;
  @ApiProperty({ type: [String] }) reasons!: string[];
}

export class OrderCommercialSummaryDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ nullable: true }) currency!: string | null;
  @ApiProperty({ nullable: true }) quotationNumber!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) quotationVersionId!:
    string | null;
  @ApiProperty({ nullable: true }) quotationStatus!: string | null;
  @ApiProperty({ nullable: true, example: '1000.00' }) quotedTotal!:
    string | null;
  @ApiProperty({ nullable: true }) acceptedTotal!: string | null;
  @ApiProperty() verifiedPaid!: string;
  @ApiProperty() pendingPayments!: string;
  @ApiProperty({ nullable: true }) remaining!: string | null;
  @ApiProperty({
    example: '0.00',
    description:
      'Verified money above the accepted total (a re-quote below what was already paid). Never refunded or altered automatically',
  })
  overpaid!: string;
  @ApiProperty({
    description:
      'A commercially relevant revision ended the accepted quotation and no new one is accepted yet',
  })
  reapprovalRequired!: boolean;
  @ApiProperty({ enum: PaymentState }) paymentState!: PaymentState;
  @ApiProperty() counts!: {
    verified: number;
    pending: number;
    rejected: number;
    cancelled: number;
  };
  @ApiProperty({ type: ReleaseGateDto }) releaseGate!: ReleaseGateDto;
}
