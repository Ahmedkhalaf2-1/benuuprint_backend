import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Trim } from '../../../common/transforms.js';
import {
  CreateSampleDto,
  UpdateSampleDto,
} from '../../samples/dto/sample.dto.js';
import {
  CUSTOMER_ACTIONS,
  type CustomerAction,
} from '../commercial/customer-commercial.js';
import {
  CUSTOMER_SAMPLE_STATUSES,
  type CustomerSampleStatus,
} from '../samples/customer-sample-status.js';

/**
 * The customer writes the request, never the internals: customerId comes from the session and
 * factoryInstructions is internal. Anything else the body carries (status, ids of other
 * customers, ...) is rejected by the global whitelist.
 */
export class CustomerCreateSampleDto extends OmitType(CreateSampleDto, [
  'customerId',
  'factoryInstructions',
] as const) {}

export class CustomerUpdateSampleDto extends OmitType(UpdateSampleDto, [
  'factoryInstructions',
] as const) {}

export const CUSTOMER_SAMPLE_SORTS = [
  'newest',
  'oldest',
  'updated',
  'submitted',
  'sampleNumber',
] as const;

export class ListCustomerSamplesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: CUSTOMER_SAMPLE_STATUSES,
    isArray: true,
    description: 'One or several customer statuses (comma-separated)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsIn(CUSTOMER_SAMPLE_STATUSES, { each: true })
  status?: CustomerSampleStatus[];

  @ApiPropertyOptional({
    description: 'Sample number, brand name, or product name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_SAMPLE_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(CUSTOMER_SAMPLE_SORTS)
  sort: (typeof CUSTOMER_SAMPLE_SORTS)[number] = 'newest';
}

export const CUSTOMER_FILE_TYPES = [
  'REFERENCE',
  'ARTWORK',
  'SIZE_CHART',
  'OTHER',
] as const;

export class CustomerUploadFileDto {
  @ApiProperty({ enum: CUSTOMER_FILE_TYPES })
  @IsEnum(CUSTOMER_FILE_TYPES)
  type!: (typeof CUSTOMER_FILE_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'ARTWORK only: the decoration this artwork is for. Creates (or adds a new version to) the sample artwork linked to it.',
  })
  @IsOptional()
  @IsUUID()
  decorationId?: string;
}

export class AcceptCustomerTermsDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Defaults to the currently active sample terms',
  })
  @IsOptional()
  @IsUUID()
  termsVersionId?: string;
}

// ---- responses ---------------------------------------------------------------------------------

class NamedRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class CustomerSampleListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SMP-000001' }) sampleNumber!: string;
  @ApiProperty({ enum: CUSTOMER_SAMPLE_STATUSES })
  status!: CustomerSampleStatus;
  @ApiProperty() statusLabel!: string;
  @ApiProperty({ description: 'What happens next, in customer language' })
  nextStep!: string;
  @ApiProperty({ description: 'True while the request can still be edited' })
  editable!: boolean;
  @ApiProperty({ type: NamedRefDto }) brand!: NamedRefDto;
  @ApiProperty({ nullable: true }) productName!: string | null;
  @ApiProperty({ nullable: true }) fabricName!: string | null;
  @ApiProperty({ nullable: true }) colorName!: string | null;
  @ApiProperty({ nullable: true }) submittedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedCustomerSamplesDto {
  @ApiProperty({ type: [CustomerSampleListItemDto] })
  data!: CustomerSampleListItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class CustomerPatternDto {
  @ApiProperty({ format: 'uuid' }) patternVersionId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) fitType!: string | null;
}

export class CustomerArtworkDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() versionCount!: number;
}

export class CustomerDecorationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: NamedRefDto }) printMethod!: NamedRefDto;
  @ApiProperty() placement!: string;
  @ApiProperty() side!: string;
  @ApiProperty({ nullable: true }) width!: string | null;
  @ApiProperty({ nullable: true }) height!: string | null;
  @ApiProperty({ nullable: true }) unit!: string | null;
  @ApiProperty({ nullable: true }) colorCount!: number | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() artworkRequired!: boolean;
  @ApiProperty({ type: CustomerArtworkDto, nullable: true })
  artwork!: CustomerArtworkDto | null;
}

export class CustomerAccessoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: NamedRefDto, nullable: true })
  accessory!: NamedRefDto | null;
  @ApiProperty({ nullable: true }) customName!: string | null;
  @ApiProperty({ nullable: true }) quantity!: number | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class CustomerComponentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: NamedRefDto, nullable: true })
  componentOption!: NamedRefDto | null;
  @ApiProperty({ nullable: true }) category!: string | null;
  @ApiProperty({ nullable: true }) customName!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class CustomerFileDto {
  @ApiProperty({
    enum: ['YOU', 'BENUE_PRINT'],
    description:
      'YOU = uploaded by you (removable while a draft); BENUE_PRINT = shared with you by our team (mockups, sample photos)',
  })
  source!: 'YOU' | 'BENUE_PRINT';
  @ApiProperty({ format: 'uuid' }) attachmentId!: string;
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty({ enum: CUSTOMER_FILE_TYPES }) type!: string;
  @ApiProperty() originalName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() uploadedAt!: Date;
}

export class CustomerTermsStateDto {
  @ApiProperty({
    description: 'Whether sample terms must be accepted to submit',
  })
  required!: boolean;
  @ApiProperty() accepted!: boolean;
  @ApiProperty({ format: 'uuid', nullable: true })
  activeTermsVersionId!: string | null;
  @ApiProperty({ nullable: true }) activeVersion!: number | null;
}

export class CustomerSampleDetailDto extends CustomerSampleListItemDto {
  @ApiProperty() revisionNumber!: number;
  @ApiProperty({ format: 'uuid', nullable: true }) productTypeId!:
    string | null;
  @ApiProperty({ nullable: true }) customProductName!: string | null;
  @ApiProperty({ nullable: true }) customProductDescription!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) fabricId!: string | null;
  @ApiProperty({ nullable: true }) customFabricName!: string | null;
  @ApiProperty({ nullable: true }) customFabricDescription!: string | null;
  @ApiProperty() fabricProvider!: string;
  @ApiProperty({ nullable: true }) gsm!: number | null;
  @ApiProperty({ format: 'uuid', nullable: true }) fabricColorId!:
    string | null;
  @ApiProperty({ nullable: true }) customColorName!: string | null;
  @ApiProperty({ nullable: true }) customPantone!: string | null;
  @ApiProperty({ nullable: true }) customHex!: string | null;
  @ApiProperty({ type: NamedRefDto, nullable: true })
  size!: NamedRefDto | null;
  @ApiProperty() fitMethod!: string;
  @ApiProperty({ type: CustomerPatternDto, nullable: true })
  pattern!: CustomerPatternDto | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) fitNotes!: string | null;
  @ApiProperty({ nullable: true }) printNotes!: string | null;
  @ApiProperty({ nullable: true }) fabricNotes!: string | null;
  @ApiProperty({ nullable: true }) specialInstructions!: string | null;
  @ApiProperty({ type: [CustomerDecorationDto] })
  decorations!: CustomerDecorationDto[];
  @ApiProperty({ type: [CustomerAccessoryDto] })
  accessories!: CustomerAccessoryDto[];
  @ApiProperty({ type: [CustomerComponentDto] })
  components!: CustomerComponentDto[];
  @ApiProperty({
    type: [CustomerFileDto],
    description: 'The files you uploaded to this request',
  })
  files!: CustomerFileDto[];
  @ApiProperty({ type: CustomerTermsStateDto }) terms!: CustomerTermsStateDto;
  @ApiProperty({
    enum: CUSTOMER_ACTIONS,
    isArray: true,
    description:
      'What you can do with this request right now, so the app does not have to re-implement the workflow',
  })
  allowedActions!: CustomerAction[];
}

export class SubmissionCheckDto {
  @ApiProperty() ready!: boolean;
  @ApiProperty({ type: [String] }) problems!: string[];
}

export class CustomerActivityEventDto {
  @ApiProperty() at!: Date;
  @ApiProperty({ enum: ['STATUS', 'PAYMENT'] }) kind!: 'STATUS' | 'PAYMENT';
  @ApiProperty({
    enum: CUSTOMER_SAMPLE_STATUSES,
    nullable: true,
    description: 'Status after the event; null for payment steps',
  })
  status!: CustomerSampleStatus | null;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) message!: string | null;
}

export class CustomerMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() at!: Date;
  @ApiProperty({ example: 'Benue Print team' }) from!: string;
  @ApiProperty() content!: string;
}

export class CustomerTermsDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty() title!: string;
  @ApiProperty() content!: string;
}

export class CustomerTermsAcceptanceDto {
  @ApiProperty({ format: 'uuid' }) termsVersionId!: string;
  @ApiProperty() version!: number;
  @ApiProperty() acceptedAt!: Date;
}
