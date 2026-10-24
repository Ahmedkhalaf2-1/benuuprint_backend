import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  NullableInt,
  NullableOptional,
  NullableText,
  NullableUuid,
  OptInt,
  OptText,
  OptUuid,
} from '../../../common/decorators/validation.decorators.js';
import { NormalizeCode, Trim } from '../../../common/transforms.js';
import {
  DecorationSide,
  MeasurementUnit,
  NoteVisibility,
} from '../../../generated/prisma/client.js';

const SIZE = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };

export class CreateDecorationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() printMethodId!: string;
  @ApiProperty({ example: 'Chest' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  placement!: string;
  @ApiPropertyOptional({ enum: DecorationSide, default: DecorationSide.FRONT })
  @IsOptional()
  @IsEnum(DecorationSide)
  side?: DecorationSide;
  @ApiPropertyOptional({ example: 25.5 })
  @IsOptional()
  @IsNumber(SIZE)
  @Min(0.01)
  @Max(1000)
  width?: number;
  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber(SIZE)
  @Min(0.01)
  @Max(1000)
  height?: number;
  @ApiPropertyOptional({
    enum: MeasurementUnit,
    description: 'Required when width or height is given',
  })
  @IsOptional()
  @IsEnum(MeasurementUnit)
  unit?: MeasurementUnit;
  @OptInt(1, 50) colorCount?: number;
  @OptText(1000) notes?: string;
  @ApiPropertyOptional({
    default: false,
    description: 'Submission requires an artwork with a usable version',
  })
  @IsOptional()
  @IsBoolean()
  artworkRequired?: boolean;
  @OptUuid() artworkId?: string;
  @OptInt(0, 10000) sortOrder?: number;
}

export class UpdateDecorationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  printMethodId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  placement?: string;
  @ApiPropertyOptional({ enum: DecorationSide })
  @IsOptional()
  @IsEnum(DecorationSide)
  side?: DecorationSide;
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @IsNumber(SIZE)
  @Min(0.01)
  @Max(1000)
  width?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @NullableOptional()
  @IsNumber(SIZE)
  @Min(0.01)
  @Max(1000)
  height?: number | null;
  @ApiPropertyOptional({ enum: MeasurementUnit, nullable: true })
  @NullableOptional()
  @IsEnum(MeasurementUnit)
  unit?: MeasurementUnit | null;
  @NullableInt(1, 50) colorCount?: number | null;
  @NullableText(1000) notes?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() artworkRequired?: boolean;
  @NullableUuid() artworkId?: string | null;
  @OptInt(0, 10000) sortOrder?: number;
}

export class CreateSampleAccessoryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Master-data accessory (exactly one of accessoryId / customName)',
  })
  @IsOptional()
  @IsUUID()
  accessoryId?: string;
  @ApiPropertyOptional({
    description: 'Free-text accessory not in the catalogue',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  customName?: string;
  @OptInt(1, 100000) quantity?: number;
  @OptText(1000) notes?: string;
  @OptInt(0, 10000) sortOrder?: number;
}

export class UpdateSampleAccessoryDto {
  @NullableInt(1, 100000) quantity?: number | null;
  @NullableText(1000) notes?: string | null;
  @OptInt(0, 10000) sortOrder?: number;
  @ApiPropertyOptional({ description: 'Only for custom accessories' })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  customName?: string;
}

export class CreateSampleComponentDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Label/packaging option (exactly one of componentOptionId / customName)',
  })
  @IsOptional()
  @IsUUID()
  componentOptionId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  customName?: string;
  @OptText(1000) notes?: string;
  @OptInt(0, 10000) sortOrder?: number;
}

export class UpdateSampleComponentDto {
  @NullableText(1000) notes?: string | null;
  @OptInt(0, 10000) sortOrder?: number;
  @ApiPropertyOptional({ description: 'Only for custom components' })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  customName?: string;
}

export class AttachSampleAssetDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Asset of type REFERENCE, MOCKUP, SIZE_CHART, ARTWORK or OTHER',
  })
  @IsUUID()
  assetId!: string;
}

export class ShareSampleFileDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Uploaded asset of type REFERENCE, MOCKUP, SIZE_CHART, ARTWORK or OTHER to show to the customer',
  })
  @IsUUID()
  assetId!: string;
}

export class SetCustomerVisibilityDto {
  @ApiProperty({
    description:
      'true = the customer sees (and can download) this file in the portal; false = staff only',
  })
  @IsBoolean()
  customerVisible!: boolean;
}

export class CreateNoteDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
  @ApiPropertyOptional({
    enum: NoteVisibility,
    default: NoteVisibility.INTERNAL,
    description:
      'CUSTOMER_VISIBLE notes are shown read-only to the customer in the portal (GET /customer/samples/:id/messages) as messages from "Benue Print team"; INTERNAL notes never leave staff',
  })
  @IsOptional()
  @IsEnum(NoteVisibility)
  visibility?: NoteVisibility;
}

export class ListNotesQueryDto {
  @ApiPropertyOptional({ enum: NoteVisibility })
  @IsOptional()
  @IsEnum(NoteVisibility)
  visibility?: NoteVisibility;
}

export class NoteResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: NoteVisibility }) visibility!: NoteVisibility;
  @ApiProperty() content!: string;
  @ApiProperty({ format: 'uuid' }) authorUserId!: string;
  @ApiProperty() authorName!: string;
  @ApiProperty() createdAt!: Date;
}

export class CreateTermsDto {
  @ApiProperty({ example: 'SAMPLE_TERMS' })
  @NormalizeCode()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code!: string;
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;
  @ApiProperty({
    description:
      'The legal text. Immutable once published; publish a new version to change it.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  content!: string;
  @ApiPropertyOptional({
    default: false,
    description:
      'Activate immediately (deactivating the previous active version)',
  })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}

export class ListTermsQueryDto {
  @ApiPropertyOptional({ example: 'SAMPLE_TERMS' })
  @IsOptional()
  @NormalizeCode()
  @IsString()
  @MaxLength(50)
  code?: string;
}

export class TermsResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() version!: number;
  @ApiProperty() title!: string;
  @ApiProperty() content!: string;
  @ApiProperty() effectiveAt!: Date;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
}

export class RecordTermsAcceptanceDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Defaults to the active SAMPLE_TERMS version',
  })
  @IsOptional()
  @IsUUID()
  termsVersionId?: string;
  @ApiProperty({
    description:
      'How the acceptance was obtained, e.g. "Confirmed by WhatsApp on 21 Oct". Required: staff are recording on behalf of the customer.',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  sourceNote!: string;
}

export class ProductionSpecResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sampleId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({
    enum: ['PRE_PRODUCTION', 'APPROVED_REFERENCE'],
    description:
      'PRE_PRODUCTION: frozen to manufacture the physical sample. APPROVED_REFERENCE: frozen at customer approval, used for bulk production.',
  })
  kind!: 'PRE_PRODUCTION' | 'APPROVED_REFERENCE';
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description:
      'APPROVED_REFERENCE: the SAMPLE_PRODUCTION factory job that built the physical sample the customer approved (null when the sample was made without a job).',
  })
  sourceFactoryJobId!: string | null;
  @ApiProperty({ description: 'SHA-256 of the canonical snapshot' })
  specHash!: string;
  @ApiProperty() schemaVersion!: number;
  @ApiProperty({ nullable: true, format: 'uuid' }) approvalId!: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The frozen, self-contained production specification',
  })
  snapshot!: Record<string, unknown>;
  @ApiProperty() createdAt!: Date;
}
