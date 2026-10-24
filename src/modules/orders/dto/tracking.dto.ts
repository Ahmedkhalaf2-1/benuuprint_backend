import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class CreateTrackingTokenDto {
  @ApiPropertyOptional({
    description: 'Link lifetime in days; omit for no expiry',
    minimum: 1,
    maximum: 730,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(730)
  expiresInDays?: number;
}

export class TrackingTokenResponseDto {
  @ApiProperty({
    description:
      'The raw token. Shown ONCE; only its hash is stored and it can never be read again.',
  })
  token!: string;
  @ApiProperty({ example: '/api/v1/track/orders/<token>' }) path!: string;
  @ApiProperty({
    nullable: true,
    description: 'Customer-facing URL when PUBLIC_APP_URL is configured',
  })
  url!: string | null;
  @ApiProperty({ nullable: true }) expiresAt!: Date | null;
  @ApiProperty({ format: 'uuid' }) tokenId!: string;
}

export class TrackingStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ nullable: true, format: 'uuid' }) tokenId!: string | null;
  @ApiProperty({ nullable: true }) createdAt!: Date | null;
  @ApiProperty({ nullable: true }) expiresAt!: Date | null;
  @ApiProperty({ nullable: true }) lastUsedAt!: Date | null;
}

export class TrackedShipmentDto {
  @ApiProperty({ example: 'SHP-000001' }) shipmentNumber!: string;
  @ApiProperty({
    enum: [
      'PREPARING',
      'ON_THE_WAY',
      'DELIVERED',
      'DELIVERY_ATTEMPT_FAILED',
      'RETURNED',
    ],
  })
  status!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ nullable: true }) courierName!: string | null;
  @ApiProperty({ nullable: true }) trackingUrl!: string | null;
  @ApiProperty({ nullable: true }) dispatchedAt!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
}

/** Everything a customer may see about an order: nothing commercial, internal or personal. */
export class PublicTrackingDto {
  @ApiProperty({ example: 'ORD-000001' }) orderNumber!: string;
  @ApiProperty({
    description:
      'Coarse status: ORDER_RECEIVED, CONFIRMED, IN_PRODUCTION, PACKING, READY_FOR_DELIVERY, PARTIALLY_SHIPPED, OUT_FOR_DELIVERY, DELIVERED, COMPLETED, ON_HOLD, CANCELLED',
  })
  status!: string;
  @ApiProperty({
    nullable: true,
    description: 'Where production is now, as a department label',
  })
  currentStage!: string | null;
  @ApiProperty({
    description:
      'Units through the final production stage ÷ units that can still be delivered',
  })
  progressPercent!: number;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty() deliveredQuantity!: number;
  @ApiProperty() remainingDeliveryQuantity!: number;
  @ApiProperty({ nullable: true }) targetDeliveryDate!: Date | null;
  @ApiProperty({ type: [TrackedShipmentDto] }) shipments!: TrackedShipmentDto[];
  @ApiProperty() updatedAt!: Date;
}
