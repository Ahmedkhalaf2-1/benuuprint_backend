import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  HEX_COLOR,
  NullableHex,
  OptInt,
  NullableInt,
  NullableText,
  NullableUuid,
  OptUuid,
} from '../../../common/decorators/validation.decorators.js';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import {
  ApprovalStatus,
  FabricProvider,
  FitMethod,
  PaymentState,
  SampleStatus,
} from '../../../generated/prisma/client.js';

export const SAMPLE_SORTS = [
  'newest',
  'oldest',
  'updated',
  'submitted',
  'sampleNumber',
] as const;

/** Everything a customer/staff fills in to describe the sample. All optional while DRAFT. */
export class CreateSampleDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ format: 'uuid', description: 'Must belong to the customer' })
  @IsUUID()
  brandId!: string;

  @OptUuid() productTypeId?: string;
  @ApiPropertyOptional({
    description:
      'Use instead of productTypeId for a product that is not in the catalogue',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  customProductName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  customProductDescription?: string;

  @OptUuid() fabricId?: string;
  @ApiPropertyOptional({
    description:
      'Use instead of fabricId for a fabric that is not in the catalogue',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  customFabricName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  customFabricDescription?: string;

  @OptUuid() fabricColorId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  customColorName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(30)
  customPantone?: string;
  @ApiPropertyOptional({ example: '#1A2B3C' })
  @IsOptional()
  @Matches(HEX_COLOR, {
    message: 'customHex must be a hex colour like #1A2B3C',
  })
  customHex?: string;

  @ApiPropertyOptional({
    enum: FabricProvider,
    default: FabricProvider.NOT_DECIDED,
  })
  @IsOptional()
  @IsEnum(FabricProvider)
  fabricProvider?: FabricProvider;
  @OptInt(1, 2000) gsm?: number;
  @OptUuid() sampleSizeOptionId?: string;
  @ApiPropertyOptional({ enum: FitMethod, default: FitMethod.NOT_SURE })
  @IsOptional()
  @IsEnum(FitMethod)
  fitMethod?: FitMethod;
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'An APPROVED pattern version; requires fitMethod BENUE_PATTERN',
  })
  @IsOptional()
  @IsUUID()
  patternVersionId?: string;

  @ApiPropertyOptional({ description: 'Customer-facing request notes' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(4000)
  notes?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  fitNotes?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  printNotes?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  fabricNotes?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  specialInstructions?: string;
  @ApiPropertyOptional({
    description: 'Internal manufacturing instructions (never customer-facing)',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(4000)
  factoryInstructions?: string;
}

/** PATCH: omitted = unchanged, null = clear. customerId is immutable. */
export class UpdateSampleDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: "DRAFT only; must belong to the sample's customer",
  })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @NullableUuid() productTypeId?: string | null;
  @NullableText(120) customProductName?: string | null;
  @NullableText(1000) customProductDescription?: string | null;
  @NullableUuid() fabricId?: string | null;
  @NullableText(120) customFabricName?: string | null;
  @NullableText(1000) customFabricDescription?: string | null;
  @NullableUuid() fabricColorId?: string | null;
  @NullableText(80) customColorName?: string | null;
  @NullableText(30) customPantone?: string | null;
  @NullableHex() customHex?: string | null;
  @ApiPropertyOptional({ enum: FabricProvider })
  @IsOptional()
  @IsEnum(FabricProvider)
  fabricProvider?: FabricProvider;
  @NullableInt(1, 2000) gsm?: number | null;
  @NullableUuid() sampleSizeOptionId?: string | null;
  @ApiPropertyOptional({ enum: FitMethod })
  @IsOptional()
  @IsEnum(FitMethod)
  fitMethod?: FitMethod;
  @NullableUuid() patternVersionId?: string | null;

  @NullableText(4000) notes?: string | null;
  @NullableText(2000) fitNotes?: string | null;
  @NullableText(2000) printNotes?: string | null;
  @NullableText(2000) fabricNotes?: string | null;
  @NullableText(2000) specialInstructions?: string | null;
  @NullableText(4000) factoryInstructions?: string | null;
}

export class ListSamplesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Sample number, customer number/name/email/phone, or brand name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: SampleStatus,
    isArray: true,
    description: 'One or several (repeat the parameter or comma-separate)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @IsEnum(SampleStatus, { each: true })
  status?: SampleStatus[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Sales owner' })
  @IsOptional()
  @IsUUID()
  assignedSalesUserId?: string;
  @ApiPropertyOptional({ description: 'Only samples without a sales owner' })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  unassigned?: boolean;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productTypeId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  fabricId?: string;
  @ApiPropertyOptional({ enum: PaymentState })
  @IsOptional()
  @IsEnum(PaymentState)
  paymentState?: PaymentState;
  @ApiPropertyOptional({
    enum: ApprovalStatus,
    description:
      'Samples having at least one approval request in this state (any approval type)',
  })
  @IsOptional()
  @IsEnum(ApprovalStatus)
  approvalState?: ApprovalStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  createdFrom?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  createdTo?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  submittedFrom?: Date;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value ? new Date(value) : value))
  submittedTo?: Date;

  @ApiPropertyOptional({
    description: 'Include archived samples (hidden by default)',
  })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;

  @ApiPropertyOptional({ enum: SAMPLE_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(SAMPLE_SORTS)
  sort: (typeof SAMPLE_SORTS)[number] = 'newest';
}

export class ReasonDto {
  @ApiProperty({
    description: 'Why (required for hold, reject, cancel and request-changes)',
  })
  @Trim()
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class OptionalReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class AssignSalesDto {
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description: 'Staff user with samples.manage; null unassigns',
  })
  @NullableUuid()
  userId!: string | null;
}

// ---- responses --------------------------------------------------------------

class RefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class SampleCustomerRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUS-000001' }) customerNumber!: string;
  @ApiProperty() displayName!: string;
}

export class SampleBrandRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BRD-000001' }) brandNumber!: string;
  @ApiProperty() name!: string;
}

export class CodedRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class SampleListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SMP-000001' }) sampleNumber!: string;
  @ApiProperty({ enum: SampleStatus }) status!: SampleStatus;
  @ApiProperty({ enum: PaymentState }) paymentState!: PaymentState;
  @ApiProperty() revisionNumber!: number;
  @ApiProperty({ type: SampleCustomerRefDto }) customer!: SampleCustomerRefDto;
  @ApiProperty({ type: SampleBrandRefDto }) brand!: SampleBrandRefDto;
  @ApiProperty({ type: CodedRefDto, nullable: true })
  productType!: CodedRefDto | null;
  @ApiProperty({ nullable: true }) customProductName!: string | null;
  @ApiProperty({ type: CodedRefDto, nullable: true })
  fabric!: CodedRefDto | null;
  @ApiProperty({ nullable: true }) customFabricName!: string | null;
  @ApiProperty({ type: RefDto, nullable: true }) assignedSales!: RefDto | null;
  @ApiProperty({ nullable: true }) submittedAt!: Date | null;
  @ApiProperty({ nullable: true }) approvedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true }) archivedAt!: Date | null;
  @ApiProperty({
    enum: ['STAFF', 'CUSTOMER_PORTAL'],
    description: 'Where the request was created',
  })
  createdVia!: 'STAFF' | 'CUSTOMER_PORTAL';
}

export class PaginatedSamplesDto {
  @ApiProperty({ type: [SampleListItemDto] }) data!: SampleListItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class SampleDecorationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: CodedRefDto }) printMethod!: CodedRefDto;
  @ApiProperty() placement!: string;
  @ApiProperty() side!: string;
  @ApiProperty({ nullable: true, type: String }) width!: string | null;
  @ApiProperty({ nullable: true, type: String }) height!: string | null;
  @ApiProperty({ nullable: true }) unit!: string | null;
  @ApiProperty({ nullable: true }) colorCount!: number | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() artworkRequired!: boolean;
  @ApiProperty({ nullable: true, format: 'uuid' }) artworkId!: string | null;
  @ApiProperty() sortOrder!: number;
}

export class SampleAccessoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: CodedRefDto, nullable: true })
  accessory!: CodedRefDto | null;
  @ApiProperty({ nullable: true }) customName!: string | null;
  @ApiProperty({ nullable: true }) quantity!: number | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() sortOrder!: number;
}

export class SampleComponentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: CodedRefDto, nullable: true })
  componentOption!: CodedRefDto | null;
  @ApiProperty({ nullable: true }) category!: string | null;
  @ApiProperty({ nullable: true }) customName!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() sortOrder!: number;
}

export class SampleAttachmentDto {
  @ApiProperty({ format: 'uuid' }) attachmentId!: string;
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty() type!: string;
  @ApiProperty() originalName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({
    description: 'Staff exposed this file to the customer (portal)',
  })
  customerVisible!: boolean;
}

export class SampleTermsAcceptanceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) termsVersionId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() version!: number;
  @ApiProperty() title!: string;
  @ApiProperty() mode!: string;
  @ApiProperty({ nullable: true }) sourceNote!: string | null;
  @ApiProperty() acceptedAt!: Date;
}

export class SamplePatternVersionRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'uuid' }) patternId!: string;
  @ApiProperty() patternCode!: string;
  @ApiProperty() patternReference!: string;
  @ApiProperty() patternName!: string;
}

export class SampleDetailResponseDto extends SampleListItemDto {
  @ApiProperty({ nullable: true }) holdPreviousStatus!: SampleStatus | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) revisionOfId!: string | null;
  @ApiProperty({ nullable: true }) customProductDescription!: string | null;
  @ApiProperty({ nullable: true }) customFabricDescription!: string | null;
  @ApiProperty({ nullable: true }) fabricColor!: {
    id: string;
    name: string;
    hex: string | null;
    pantone: string | null;
  } | null;
  @ApiProperty({ nullable: true }) customColorName!: string | null;
  @ApiProperty({ nullable: true }) customPantone!: string | null;
  @ApiProperty({ nullable: true }) customHex!: string | null;
  @ApiProperty({ enum: FabricProvider }) fabricProvider!: FabricProvider;
  @ApiProperty({ nullable: true }) gsm!: number | null;
  @ApiProperty({ nullable: true }) sampleSize!: {
    id: string;
    code: string;
    name: string;
    scaleCode: string;
  } | null;
  @ApiProperty({ enum: FitMethod }) fitMethod!: FitMethod;
  @ApiProperty({ type: SamplePatternVersionRefDto, nullable: true })
  patternVersion!: SamplePatternVersionRefDto | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) fitNotes!: string | null;
  @ApiProperty({ nullable: true }) printNotes!: string | null;
  @ApiProperty({ nullable: true }) fabricNotes!: string | null;
  @ApiProperty({ nullable: true }) specialInstructions!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'Internal; excluded from any customer-facing projection',
  })
  factoryInstructions!: string | null;
  @ApiProperty({ nullable: true }) reviewedAt!: Date | null;
  @ApiProperty({ nullable: true }) completedAt!: Date | null;
  @ApiProperty({
    type: [SampleDecorationDto],
    description: 'Empty means no print',
  })
  decorations!: SampleDecorationDto[];
  @ApiProperty({ type: [SampleAccessoryDto] })
  accessories!: SampleAccessoryDto[];
  @ApiProperty({
    type: [SampleComponentDto],
    description: 'Labels and packaging',
  })
  components!: SampleComponentDto[];
  @ApiProperty({ type: [SampleAttachmentDto] })
  attachments!: SampleAttachmentDto[];
  @ApiProperty({ type: [SampleTermsAcceptanceDto] })
  termsAcceptances!: SampleTermsAcceptanceDto[];
  @ApiProperty({
    type: [String],
    description: 'Staff actions available in the current status',
  })
  allowedActions!: string[];
}

export class SampleStatusHistoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) fromStatus!: SampleStatus | null;
  @ApiProperty() toStatus!: SampleStatus;
  @ApiProperty() action!: string;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) actorUserId!: string | null;
  @ApiProperty({ enum: ['STAFF', 'SYSTEM'] }) source!: string;
  @ApiProperty() createdAt!: Date;
}
