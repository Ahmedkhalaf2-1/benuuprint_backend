import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Trim } from '../../../common/transforms.js';
import { NullableOptional } from '../../../common/decorators/validation.decorators.js';
import {
  CUSTOMER_ORDER_ACTIONS,
  CUSTOMER_ORDER_STATUSES,
  type CustomerOrderAction,
  type CustomerOrderStatus,
} from '../orders/customer-order-status.js';
import { CustomerPaymentSummaryDto } from './customer-commercial.dto.js';

const MAX_UNITS = 1_000_000;

// ---- input -------------------------------------------------------------------------------------

/**
 * One size / colour line. Catalogue sizes and the catalogue colours of the approved fabric only: custom
 * sizes or colours would change the manufacturing baseline and need a new sample, so they are not accepted.
 */
export class CustomerVariantInputDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'A size option id' })
  @IsOptional()
  @IsUUID()
  sizeOptionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "A colour of the approved sample's fabric; omit to keep the approved colour",
  })
  @IsOptional()
  @IsUUID()
  fabricColorId?: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNITS)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** The (single) product line of the order: its total and its size / colour breakdown. */
export class CustomerOrderItemsDto {
  @ApiProperty({
    minimum: 1,
    description:
      'Total units; must equal the sum of the variants when you submit',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNITS)
  quantity!: number;

  @ApiProperty({ type: [CustomerVariantInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => CustomerVariantInputDto)
  variants!: CustomerVariantInputDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CustomerCreateOrderDto {
  @ApiPropertyOptional({ type: CustomerOrderItemsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerOrderItemsDto)
  items?: CustomerOrderItemsDto;

  @ApiPropertyOptional({ description: 'When you would like it delivered' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetDeliveryDate?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  customerNotes?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'One of your own addresses',
  })
  @IsOptional()
  @IsUUID()
  preferredAddressId?: string;
}

export class CustomerUpdateOrderDto {
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Type(() => Date)
  @IsDate()
  targetDeliveryDate?: Date | null;

  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  customerNotes?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @NullableOptional()
  @IsUUID()
  preferredAddressId?: string | null;
}

export class CustomerReorderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetDeliveryDate?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  customerNotes?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Copy the quantities and size / colour breakdown of the order',
  })
  @IsOptional()
  @IsBoolean()
  cloneItems?: boolean;
}

export const CUSTOMER_ORDER_SORTS = [
  'newest',
  'oldest',
  'updated',
  'orderNumber',
  'targetDate',
] as const;

export class ListCustomerOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: CUSTOMER_ORDER_STATUSES,
    isArray: true,
    description: 'One or several customer statuses (comma-separated)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsIn(CUSTOMER_ORDER_STATUSES, { each: true })
  status?: CustomerOrderStatus[];

  @ApiPropertyOptional({ description: 'Order number, brand or product name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_ORDER_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(CUSTOMER_ORDER_SORTS)
  sort: (typeof CUSTOMER_ORDER_SORTS)[number] = 'newest';
}

// ---- output ------------------------------------------------------------------------------------

class RefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class CustomerOrderListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'ORD-000001' }) orderNumber!: string;
  @ApiProperty({ enum: CUSTOMER_ORDER_STATUSES })
  status!: CustomerOrderStatus;
  @ApiProperty() statusLabel!: string;
  @ApiProperty() nextStep!: string;
  @ApiProperty({ type: RefDto }) brand!: RefDto;
  @ApiProperty({ nullable: true }) productName!: string | null;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty({ nullable: true }) targetDeliveryDate!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedCustomerOrdersDto {
  @ApiProperty({ type: [CustomerOrderListItemDto] })
  data!: CustomerOrderListItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class CustomerOrderVariantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) size!: string | null;
  @ApiProperty({ nullable: true }) color!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) sizeOptionId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true })
  fabricColorId!: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class CustomerOrderItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ type: [CustomerOrderVariantDto] })
  variants!: CustomerOrderVariantDto[];
}

class ReferenceSummaryDto {
  @ApiProperty({ example: 'SMP-000001' }) sampleNumber!: string;
  @ApiProperty({ format: 'uuid' }) sampleId!: string;
  @ApiProperty() productName!: string;
}

class OrderQuantitiesDto {
  @ApiProperty() total!: number;
  @ApiProperty({
    description: 'Units on shipments that left us (on the way or delivered)',
  })
  shipped!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty({
    description: 'Units not yet shipped (excluding rejected units)',
  })
  remaining!: number;
}

class OrderCommercialBriefDto {
  @ApiProperty({
    enum: [
      'NOT_REQUIRED_YET',
      'PAYMENT_REQUIRED',
      'PAYMENT_UNDER_REVIEW',
      'PAID',
    ],
  })
  paymentStatus!: string;
  @ApiProperty({ nullable: true, example: 'EGP' }) currency!: string | null;
  @ApiProperty({ nullable: true }) requiredAmount!: string | null;
  @ApiProperty({ nullable: true }) remainingAmount!: string | null;
  @ApiProperty({
    description:
      'Our team changed something that affects the price: a new quotation must be accepted',
  })
  requiresReview!: boolean;
}

export class CustomerOrderDetailDto extends CustomerOrderListItemDto {
  @ApiProperty({
    enum: CUSTOMER_ORDER_ACTIONS,
    isArray: true,
    description: 'What you can do with this order right now',
  })
  allowedActions!: CustomerOrderAction[];
  @ApiProperty({ type: ReferenceSummaryDto }) reference!: ReferenceSummaryDto;
  @ApiProperty({ type: [CustomerOrderItemDto] }) items!: CustomerOrderItemDto[];
  @ApiProperty({ type: OrderQuantitiesDto }) quantities!: OrderQuantitiesDto;
  @ApiProperty({ nullable: true }) customerNotes!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true })
  preferredAddressId!: string | null;
  @ApiProperty({ nullable: true }) confirmedAt!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
  @ApiProperty({ nullable: true, example: 'ORD-000001' })
  reorderOf!: string | null;
  @ApiProperty({ type: OrderCommercialBriefDto })
  commercial!: OrderCommercialBriefDto;
  @ApiProperty({ minimum: 0, maximum: 100 }) progressPercent!: number;
}

export class CustomerOrderCommercialDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ nullable: true }) quotationNumber!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true })
  actionableVersionId!: string | null;
  @ApiProperty() requiresReview!: boolean;
  @ApiProperty({ nullable: true }) notice!: string | null;
  @ApiProperty({ type: CustomerPaymentSummaryDto })
  payment!: CustomerPaymentSummaryDto;
  @ApiProperty({
    description:
      'Backend release gate: production can start only when this is satisfied (by our team)',
  })
  readyForProduction!: boolean;
  @ApiProperty({ enum: ['REVIEW_QUOTATION', 'PAY', 'NONE'] })
  nextAction!: string;
  @ApiProperty({ enum: CUSTOMER_ORDER_ACTIONS, isArray: true })
  allowedActions!: CustomerOrderAction[];
}

export class CustomerOrderProductionStepDto {
  @ApiProperty({
    enum: [
      'PREPARING_MATERIALS',
      'PATTERN_AND_CUTTING',
      'DECORATION',
      'SEWING',
      'QUALITY_CHECK',
      'PACKAGING',
      'READY_FOR_SHIPMENT',
    ],
  })
  code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['PENDING', 'ACTIVE', 'DONE'] }) state!: string;
}

class CustomerEtaDto {
  @ApiProperty() estimatedCompletion!: Date;
  @ApiProperty({ enum: ['ESTIMATED', 'APPROXIMATE'] }) confidence!: string;
  @ApiProperty() note!: string;
}

export class CustomerOrderProductionDto {
  @ApiProperty({ enum: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'] })
  phase!: string;
  @ApiProperty({ type: [CustomerOrderProductionStepDto] })
  steps!: CustomerOrderProductionStepDto[];
  @ApiProperty({ minimum: 0, maximum: 100 }) progressPercent!: number;
  @ApiProperty({ enum: ['NOT_STARTED', 'IN_PACKAGING', 'READY_FOR_SHIPMENT'] })
  packaging!: string;
  @ApiProperty({ type: CustomerEtaDto, nullable: true })
  eta!: CustomerEtaDto | null;
}

export class CustomerShipmentLineDto {
  @ApiProperty({ nullable: true }) size!: string | null;
  @ApiProperty({ nullable: true }) color!: string | null;
  @ApiProperty() quantity!: number;
}

export class CustomerShipmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
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
  @ApiProperty({ nullable: true, description: 'City and country only' })
  destination!: string | null;
  @ApiProperty({ nullable: true }) courierName!: string | null;
  @ApiProperty({ nullable: true }) trackingNumber!: string | null;
  @ApiProperty({ nullable: true }) trackingUrl!: string | null;
  @ApiProperty({ nullable: true }) scheduledAt!: Date | null;
  @ApiProperty({ nullable: true }) dispatchedAt!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
}

export class CustomerShipmentDetailDto extends CustomerShipmentDto {
  @ApiProperty({ type: [CustomerShipmentLineDto] })
  lines!: CustomerShipmentLineDto[];
}

export class CustomerShipmentSummaryDto {
  @ApiProperty() totalUnits!: number;
  @ApiProperty() shippedUnits!: number;
  @ApiProperty() deliveredUnits!: number;
  @ApiProperty() remainingUnits!: number;
  @ApiProperty({
    description: 'Some, but not all, of the units have shipped',
  })
  partiallyShipped!: boolean;
}

export class CustomerOrderShipmentsDto {
  @ApiProperty({ type: CustomerShipmentSummaryDto })
  summary!: CustomerShipmentSummaryDto;
  @ApiProperty({ type: [CustomerShipmentDto] })
  shipments!: CustomerShipmentDto[];
}

export class CustomerOrderActivityDto {
  @ApiProperty() at!: Date;
  @ApiProperty({ enum: ['ORDER', 'PAYMENT'] }) kind!: 'ORDER' | 'PAYMENT';
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) message!: string | null;
}
