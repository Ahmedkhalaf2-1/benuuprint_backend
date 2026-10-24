import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  NullableText,
  NullableUuid,
  OptEnum,
  OptText,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import {
  FactoryJobSourceType,
  FactoryJobStatus,
  JobPriority,
  OrderActivityType,
  OrderBatchStatus,
  OrderStatus,
  PaymentState,
  ShipmentStatus,
} from '../../../generated/prisma/client.js';
import { OrderCommercialSummaryDto } from './commercial.dto.js';

const MAX_UNITS = 10_000_000;

export class OrderVariantInputDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Keep an existing variant (update it); omit to add a new one',
  })
  @IsOptional()
  @IsUUID()
  id?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sizeOptionId?: string;
  @ApiPropertyOptional({
    example: 'XXL-Tall',
    description: 'Instead of a catalogue size',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  customSizeName?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A colour of the approved fabric',
  })
  @IsOptional()
  @IsUUID()
  fabricColorId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  customColorName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(40)
  pantone?: string;
  @ApiPropertyOptional({ example: '#112233' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  hex?: string;
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNITS)
  quantity!: number;
  @OptText(1000) notes?: string;
}

export class OrderItemInputDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Keep an existing item (update it); omit to add a new one',
  })
  @IsOptional()
  @IsUUID()
  id?: string;
  @ApiProperty({
    minimum: 1,
    description:
      'Must equal the sum of its variants when the order is confirmed',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNITS)
  quantity!: number;
  @OptText(1000) notes?: string;
  @ApiProperty({ type: [OrderVariantInputDto] })
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => OrderVariantInputDto)
  variants!: OrderVariantInputDto[];
}

export class ReplaceOrderItemsDto {
  @ApiProperty({ type: [OrderItemInputDto] })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

export class CreateOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetDeliveryDate?: Date;
  @OptEnum(JobPriority) priority?: JobPriority;
  @ApiPropertyOptional({
    format: 'uuid',
    description: "Defaults to the sample's sales owner",
  })
  @IsOptional()
  @IsUUID()
  assignedSalesUserId?: string;
  @OptText(2000) internalNotes?: string;
  @ApiPropertyOptional({
    type: [OrderItemInputDto],
    description: 'Optional starting quantities / variants',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];
}

export class UpdateOrderDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === null ? null : value ? new Date(value) : value,
  )
  targetDeliveryDate?: Date | null;
  @NullableUuid() assignedSalesUserId?: string | null;
  @NullableText(2000) internalNotes?: string | null;
}

export class OrderReasonDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ChangeOrderPriorityDto {
  @ApiProperty({ enum: JobPriority })
  @IsEnum(JobPriority)
  priority!: JobPriority;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ForceCompleteOrderDto {
  @ApiProperty({
    description:
      'Why the order is closed without the normal delivery path (audited)',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ReviseOrderDto {
  @ApiProperty({
    description:
      'Why the confirmed order changes (kept in the revision history)',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
  @ApiPropertyOptional({
    type: [OrderItemInputDto],
    description:
      'Only before production starts and while no batch or job exists',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === null ? null : value ? new Date(value) : value,
  )
  targetDeliveryDate?: Date | null;
  @NullableText(2000) internalNotes?: string | null;
}

export class ReorderDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'Copy the previous quantities and size/colour breakdown into the new DRAFT',
  })
  @IsOptional()
  @IsBoolean()
  cloneItems?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetDeliveryDate?: Date;
  @OptEnum(JobPriority) priority?: JobPriority;
  @OptText(2000) internalNotes?: string;
}

export const ORDER_SORTS = [
  'newest',
  'oldest',
  'target',
  'priority',
  'orderNumber',
] as const;

export class ListOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Order number, customer name/number/email/phone, brand, sample number',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({ enum: OrderStatus, isArray: true })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsEnum(OrderStatus, { each: true })
  status?: OrderStatus[];
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedSalesUserId?: string;
  @OptEnum(JobPriority) priority?: JobPriority;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sourceSampleId?: string;
  @ApiPropertyOptional({
    enum: ['NOT_STARTED', 'IN_PRODUCTION', 'COMPLETED'],
    description: 'Derived from the order status',
  })
  @IsOptional()
  @IsIn(['NOT_STARTED', 'IN_PRODUCTION', 'COMPLETED'])
  productionStatus?: 'NOT_STARTED' | 'IN_PRODUCTION' | 'COMPLETED';
  @ApiPropertyOptional({
    description:
      'Past its target delivery date (or with a delayed production stage) and not finished',
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  delayed?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  createdFrom?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  createdTo?: Date;
  @ApiPropertyOptional({ description: 'Target delivery on or before' })
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  targetBefore?: Date;
  @ApiPropertyOptional({ description: 'Status READY_FOR_DELIVERY' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  readyForDelivery?: boolean;
  @ApiPropertyOptional({ description: 'DELIVERED or COMPLETED' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  delivered?: boolean;
  @ApiPropertyOptional({
    enum: ShipmentStatus,
    description: 'Has a shipment in this status',
  })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  shipmentStatus?: ShipmentStatus;
  @ApiPropertyOptional({ enum: PaymentState })
  @IsOptional()
  @IsEnum(PaymentState)
  paymentState?: PaymentState;
  @ApiPropertyOptional({
    description:
      'true: packed and ready (READY_FOR_DELIVERY onwards); false: still in production or packaging',
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  packagingComplete?: boolean;
  @ApiPropertyOptional({ enum: ORDER_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(ORDER_SORTS)
  sort: (typeof ORDER_SORTS)[number] = 'newest';
}

// ───────────── responses ─────────────

export class OrderPartyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) number!: string | null;
}

export class OrderVariantResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) sizeOptionId!: string | null;
  @ApiProperty({ nullable: true }) sizeName!: string | null;
  @ApiProperty({ nullable: true }) customSizeName!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) fabricColorId!:
    string | null;
  @ApiProperty({ nullable: true }) colorName!: string | null;
  @ApiProperty({ nullable: true }) customColorName!: string | null;
  @ApiProperty({ nullable: true }) pantone!: string | null;
  @ApiProperty({ nullable: true }) hex!: string | null;
  @ApiProperty({ description: 'e.g. Black / M' }) label!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() completedQuantity!: number;
  @ApiProperty() rejectedQuantity!: number;
  @ApiProperty({ description: 'Units already placed in non-cancelled batches' })
  allocatedQuantity!: number;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class OrderItemResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() productName!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) productTypeId!:
    string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty({ description: 'Sum of the variant quantities' })
  variantTotal!: number;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ type: [OrderVariantResponseDto] })
  variants!: OrderVariantResponseDto[];
}

export class ApprovedReferenceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['APPROVED_REFERENCE'] }) kind!: string;
  @ApiProperty() specHash!: string;
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description:
      'The SAMPLE_PRODUCTION job that built the approved physical sample',
  })
  sourceFactoryJobId!: string | null;
  @ApiProperty({ nullable: true }) sourceFactoryJobNumber!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class OrderSpecSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty() specHash!: string;
  @ApiProperty() createdAt!: Date;
}

export class OrderJobSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() jobNumber!: string;
  @ApiProperty({ enum: FactoryJobSourceType })
  sourceType!: FactoryJobSourceType;
  @ApiProperty({ enum: FactoryJobStatus }) status!: FactoryJobStatus;
  @ApiProperty({ nullable: true, format: 'uuid' }) orderBatchId!: string | null;
  @ApiProperty({ nullable: true }) batchNumber!: string | null;
  @ApiProperty({ nullable: true }) plannedQuantity!: number | null;
  @ApiProperty() completedQuantity!: number;
  @ApiProperty() rejectedQuantity!: number;
}

export class BatchAllocationResponseDto {
  @ApiProperty({ format: 'uuid' }) orderVariantId!: string;
  @ApiProperty() label!: string;
  @ApiProperty() quantity!: number;
}

export class OrderBatchResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BAT-000001' }) batchNumber!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: OrderBatchStatus }) status!: OrderBatchStatus;
  @ApiProperty() quantity!: number;
  @ApiProperty({ nullable: true }) targetStartDate!: Date | null;
  @ApiProperty({ nullable: true }) targetCompletionDate!: Date | null;
  @ApiProperty({ nullable: true }) startedAt!: Date | null;
  @ApiProperty({ nullable: true }) completedAt!: Date | null;
  @ApiProperty({ nullable: true }) holdReason!: string | null;
  @ApiProperty({ nullable: true }) cancelReason!: string | null;
  @ApiProperty({ type: [BatchAllocationResponseDto] })
  allocations!: BatchAllocationResponseDto[];
  @ApiProperty({ type: OrderJobSummaryDto, nullable: true })
  job!: OrderJobSummaryDto | null;
  @ApiProperty() createdAt!: Date;
}

export class OrderActivityResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: OrderActivityType }) type!: OrderActivityType;
  @ApiProperty() message!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) actorUserId!: string | null;
  @ApiProperty({ nullable: true }) actorName!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown> | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedOrderActivitiesDto {
  @ApiProperty({ type: [OrderActivityResponseDto] })
  data!: OrderActivityResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class OrderRevisionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() revisionNumber!: number;
  @ApiProperty() reason!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The frozen specification that was in force before this revision',
  })
  previousSnapshot!: Record<string, unknown>;
  @ApiProperty({ format: 'uuid' }) specId!: string;
  @ApiProperty({ format: 'uuid' }) createdByUserId!: string;
  @ApiProperty({
    description:
      'Changed commercially relevant data: quotations accepted before it no longer apply',
  })
  commercialImpact!: boolean;
  @ApiProperty({ type: [String], description: 'What made it commercial' })
  commercialChanges!: string[];
  @ApiProperty() createdAt!: Date;
}

export class StageProgressDto {
  @ApiProperty() stageCode!: string;
  @ApiProperty() stageName!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true }) required!: number | null;
  @ApiProperty({ nullable: true }) accounted!: number | null;
  @ApiProperty() isDelayed!: boolean;
}

export class JobProgressDto {
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty() jobNumber!: string;
  @ApiProperty({ enum: FactoryJobStatus }) status!: FactoryJobStatus;
  @ApiProperty({ nullable: true }) batchNumber!: string | null;
  @ApiProperty({ nullable: true }) plannedQuantity!: number | null;
  @ApiProperty() completedQuantity!: number;
  @ApiProperty() rejectedQuantity!: number;
  @ApiProperty({
    type: StageProgressDto,
    nullable: true,
    description: 'The furthest stage that is ready, running or blocked',
  })
  currentStage!: StageProgressDto | null;
  @ApiProperty({ type: [StageProgressDto] }) activeStages!: StageProgressDto[];
  @ApiProperty({ type: [StageProgressDto] }) blockedStages!: StageProgressDto[];
  @ApiProperty({ type: [StageProgressDto] }) delayedStages!: StageProgressDto[];
}

export class ProductionSummaryDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty({ description: 'Units that passed the final stage' })
  completedQuantity!: number;
  @ApiProperty({ description: 'Units scrapped' }) rejectedQuantity!: number;
  @ApiProperty({
    description: 'Units currently sent back by QC / admins and not yet redone',
  })
  reworkQuantity!: number;
  @ApiProperty({ description: 'Units flagged for rework in stage reports' })
  reworkFlaggedQuantity!: number;
  @ApiProperty({
    description:
      'Ordered units not yet delivered through the final stage nor rejected',
  })
  remainingQuantity!: number;
  @ApiProperty({
    description:
      'Units through the final stage ÷ units that can still be delivered (total − rejected). Not an average of stage percentages.',
  })
  progressPercent!: number;
  @ApiProperty({ nullable: true }) targetDeliveryDate!: Date | null;
  @ApiProperty() isPastTargetDate!: boolean;
  @ApiProperty({ type: [OrderBatchResponseDto] })
  batches!: OrderBatchResponseDto[];
  @ApiProperty({ type: [JobProgressDto] }) jobs!: JobProgressDto[];
  @ApiProperty({ type: [StageProgressDto] }) activeStages!: StageProgressDto[];
  @ApiProperty({ type: [StageProgressDto] }) blockedStages!: StageProgressDto[];
  @ApiProperty({ type: [StageProgressDto] }) delayedStages!: StageProgressDto[];
  @ApiProperty({ type: StageProgressDto, nullable: true })
  currentStage!: StageProgressDto | null;
}

export class OrderListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'ORD-000001' }) orderNumber!: string;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty({ enum: JobPriority }) priority!: JobPriority;
  @ApiProperty({ type: OrderPartyDto }) customer!: OrderPartyDto;
  @ApiProperty({ type: OrderPartyDto }) brand!: OrderPartyDto;
  @ApiProperty({ example: 'SMP-000001' }) sampleNumber!: string;
  @ApiProperty({ nullable: true }) reorderOfOrderNumber!: string | null;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty() completedQuantity!: number;
  @ApiProperty() rejectedQuantity!: number;
  @ApiProperty() progressPercent!: number;
  @ApiProperty() revisionNumber!: number;
  @ApiProperty({ nullable: true }) targetDeliveryDate!: Date | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) assignedSalesUserId!:
    string | null;
  @ApiProperty() isDelayed!: boolean;
  @ApiProperty({ enum: PaymentState }) paymentState!: PaymentState;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedOrdersDto {
  @ApiProperty({ type: [OrderListItemDto] }) data!: OrderListItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class OrderShipmentSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SHP-000001' }) shipmentNumber!: string;
  @ApiProperty({ enum: ShipmentStatus }) status!: ShipmentStatus;
  @ApiProperty() quantity!: number;
  @ApiProperty({ nullable: true }) dispatchedAt!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
}

export class OrderFulfillmentDto {
  @ApiProperty() deliveredQuantity!: number;
  @ApiProperty({
    description: 'On shipments that are dispatched or in transit',
  })
  inFlightQuantity!: number;
  @ApiProperty({
    description:
      'Units that can still go on a new shipment (produced, packed, not committed)',
  })
  shippableQuantity!: number;
  @ApiProperty({
    description:
      'Deliverable units not yet delivered (ordered − scrapped − delivered)',
  })
  remainingDeliveryQuantity!: number;
  @ApiProperty() packagingDefined!: boolean;
  @ApiProperty() packedQuantity!: number;
  @ApiProperty() packagingComplete!: boolean;
  @ApiProperty() trackingEnabled!: boolean;
}

export class OrderDetailDto extends OrderListItemDto {
  @ApiProperty({ format: 'uuid' }) sourceSampleId!: string;
  @ApiProperty() sampleRevision!: number;
  @ApiProperty({ type: ApprovedReferenceDto })
  approvedReference!: ApprovedReferenceDto;
  @ApiProperty({
    type: OrderSpecSummaryDto,
    nullable: true,
    description:
      'The frozen order specification in force (set at confirmation)',
  })
  currentSpec!: OrderSpecSummaryDto | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) reorderOfOrderId!:
    string | null;
  @ApiProperty({ nullable: true }) confirmedAt!: Date | null;
  @ApiProperty({ nullable: true }) productionStartDate!: Date | null;
  @ApiProperty({ nullable: true, description: 'When production finished' })
  completedAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'When every deliverable unit was delivered',
  })
  deliveredAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'When the order was closed (COMPLETED)',
  })
  closedAt!: Date | null;
  @ApiProperty({ nullable: true }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true }) cancellationReason!: string | null;
  @ApiProperty({ nullable: true }) holdReason!: string | null;
  @ApiProperty({ nullable: true }) internalNotes!: string | null;
  @ApiProperty({ type: [OrderItemResponseDto] }) items!: OrderItemResponseDto[];
  @ApiProperty({ type: [OrderBatchResponseDto] })
  batches!: OrderBatchResponseDto[];
  @ApiProperty({ type: [OrderJobSummaryDto] })
  factoryJobs!: OrderJobSummaryDto[];
  @ApiProperty({ type: ProductionSummaryDto })
  productionSummary!: ProductionSummaryDto;
  @ApiProperty({ type: OrderFulfillmentDto }) fulfillment!: OrderFulfillmentDto;
  @ApiProperty({ type: [OrderShipmentSummaryDto] })
  shipments!: OrderShipmentSummaryDto[];
  @ApiPropertyOptional({
    type: OrderCommercialSummaryDto,
    description: 'Only for callers holding orders.commercial.read',
  })
  commercial?: OrderCommercialSummaryDto;
  @ApiProperty({
    type: [OrderActivityResponseDto],
    description: 'The latest 20 events; page through /activities for all',
  })
  recentActivities!: OrderActivityResponseDto[];
}

// ───────────── batches ─────────────

export class BatchAllocationInputDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() orderVariantId!: string;
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNITS)
  quantity!: number;
}

export class CreateOrderBatchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetStartDate?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetCompletionDate?: Date;
  @ApiProperty({ type: [BatchAllocationInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => BatchAllocationInputDto)
  allocations!: BatchAllocationInputDto[];
}

export class ReplaceBatchAllocationsDto {
  @ApiProperty({ type: [BatchAllocationInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => BatchAllocationInputDto)
  allocations!: BatchAllocationInputDto[];
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetStartDate?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  targetCompletionDate?: Date;
}
