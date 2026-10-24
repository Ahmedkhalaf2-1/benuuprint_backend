import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { NullableText } from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import {
  DeliveryMethod,
  ShipmentStatus,
} from '../../../generated/prisma/client.js';

const PHONE = /^[+0-9][0-9 ()-]{5,24}$/;

export class ShipmentAddressInputDto {
  @ApiPropertyOptional({ example: 'Egypt' })
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
  state?: string;
  @ApiProperty() @Trim() @IsString() @MinLength(1) @MaxLength(80) city!: string;
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
  @MaxLength(500)
  notes?: string;
}

export class ShipmentLineInputDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() orderVariantId!: string;
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  quantity!: number;
}

export class CreateShipmentDto {
  @ApiProperty({ enum: DeliveryMethod })
  @IsEnum(DeliveryMethod)
  deliveryMethod!: DeliveryMethod;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  recipientName!: string;
  @ApiProperty({ example: '+201001112233' })
  @Trim()
  @Matches(PHONE, { message: 'recipientPhone is not a valid phone number' })
  recipientPhone!: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "One of the order customer's addresses; it is copied (snapshotted), never referenced live",
  })
  @IsOptional()
  @IsUUID()
  customerAddressId?: string;
  @ApiPropertyOptional({
    type: ShipmentAddressInputDto,
    description: 'A one-off destination instead of a saved address',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShipmentAddressInputDto)
  address?: ShipmentAddressInputDto;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  courierName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  trackingNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  trackingUrl?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
  @ApiPropertyOptional({ description: 'Instructions for the delivery person' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  deliveryNotes?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedDeliveryUserId?: string;
  @ApiProperty({ type: [ShipmentLineInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineInputDto)
  lines!: ShipmentLineInputDto[];
}

export class UpdateShipmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  recipientName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @Matches(PHONE, { message: 'recipientPhone is not a valid phone number' })
  recipientPhone?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  courierName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  trackingNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  trackingUrl?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === null ? null : value ? new Date(value) : value,
  )
  scheduledAt?: Date | null;
  @NullableText(1000) notes?: string | null;
  @NullableText(1000) deliveryNotes?: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  assignedDeliveryUserId?: string | null;
  @ApiPropertyOptional({
    type: [ShipmentLineInputDto],
    description: 'Replaces the lines of a DRAFT shipment',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineInputDto)
  lines?: ShipmentLineInputDto[];
}

export class DispatchShipmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  courierName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  trackingNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  trackingUrl?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class DeliverShipmentDto {
  @ApiPropertyOptional({ description: 'Who received it, remarks' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  notes?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A DELIVERY_PROOF asset uploaded for this shipment (never public)',
  })
  @IsOptional()
  @IsUUID()
  proofAssetId?: string;
}

export class ShipmentReasonDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ListShipmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ShipmentStatus })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  orderId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedDeliveryUserId?: string;
  @ApiPropertyOptional({
    description: 'Shipment number, tracking number, recipient',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({ description: 'Only shipments that are not final' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  open?: boolean;
}

export class ShipmentLineResponseDto {
  @ApiProperty({ format: 'uuid' }) orderVariantId!: string;
  @ApiProperty({ example: 'Black / M' }) label!: string;
  @ApiProperty() quantity!: number;
}

export class ShipmentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SHP-000001' }) shipmentNumber!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ example: 'ORD-000001' }) orderNumber!: string;
  @ApiProperty({ enum: ShipmentStatus }) status!: ShipmentStatus;
  @ApiProperty({ enum: DeliveryMethod }) deliveryMethod!: DeliveryMethod;
  @ApiProperty() recipientName!: string;
  @ApiProperty() recipientPhone!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The destination as it was when the shipment was created',
  })
  addressSnapshot!: Record<string, unknown>;
  @ApiProperty({ nullable: true }) courierName!: string | null;
  @ApiProperty({ nullable: true }) trackingNumber!: string | null;
  @ApiProperty({ nullable: true }) trackingUrl!: string | null;
  @ApiProperty({ nullable: true }) scheduledAt!: Date | null;
  @ApiProperty({ nullable: true }) readyAt!: Date | null;
  @ApiProperty({ nullable: true }) dispatchedAt!: Date | null;
  @ApiProperty({ nullable: true }) inTransitAt!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
  @ApiProperty({ nullable: true }) failedAt!: Date | null;
  @ApiProperty({ nullable: true }) returnedAt!: Date | null;
  @ApiProperty({ nullable: true }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true }) failureReason!: string | null;
  @ApiProperty({ nullable: true }) returnReason!: string | null;
  @ApiProperty({ nullable: true }) cancelReason!: string | null;
  @ApiProperty({
    description:
      'A delivery proof file is attached (download through the proof-url endpoint)',
  })
  hasProof!: boolean;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) deliveryNotes!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) assignedDeliveryUserId!:
    string | null;
  @ApiProperty({ nullable: true }) assignedDeliveryName!: string | null;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty({ type: [ShipmentLineResponseDto] })
  lines!: ShipmentLineResponseDto[];
  @ApiProperty() createdAt!: Date;
}

export class PaginatedShipmentsDto {
  @ApiProperty({ type: [ShipmentResponseDto] }) data!: ShipmentResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

/** What delivery staff see: the shipment, recipient, address, quantities and notes. Nothing commercial or production-related. */
export class StaffDeliveryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() shipmentNumber!: string;
  @ApiProperty({ enum: ShipmentStatus }) status!: ShipmentStatus;
  @ApiProperty({ enum: DeliveryMethod }) deliveryMethod!: DeliveryMethod;
  @ApiProperty() recipientName!: string;
  @ApiProperty() recipientPhone!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) address!: Record<
    string,
    unknown
  >;
  @ApiProperty({ type: [ShipmentLineResponseDto] })
  packages!: ShipmentLineResponseDto[];
  @ApiProperty() totalQuantity!: number;
  @ApiProperty({ nullable: true }) deliveryNotes!: string | null;
  @ApiProperty({ nullable: true }) courierName!: string | null;
  @ApiProperty({ nullable: true }) trackingNumber!: string | null;
  @ApiProperty({ nullable: true }) scheduledAt!: Date | null;
  @ApiProperty({ nullable: true }) dispatchedAt!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
  @ApiProperty() hasProof!: boolean;
}

export class PaginatedStaffDeliveriesDto {
  @ApiProperty({ type: [StaffDeliveryDto] }) data!: StaffDeliveryDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class ListMyDeliveriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ShipmentStatus })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;
  @ApiPropertyOptional({
    description: 'Include finished deliveries (default: only open ones)',
  })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  includeFinished?: boolean;
}
