import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { ToBoolean, Trim } from '../../../common/transforms.js';
import {
  NotificationChannel,
  NotificationRecipientKind,
  NotificationSeverity,
  NotificationStatus,
} from '../../../generated/prisma/client.js';
import { NOTIFICATION_CATEGORIES } from '../events.js';

const DATE = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export class ListMyNotificationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Only unread notifications' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  unread?: boolean;
  @ApiPropertyOptional({ enum: NotificationSeverity })
  @IsOptional()
  @IsEnum(NotificationSeverity)
  severity?: NotificationSeverity;
  @ApiPropertyOptional({ example: 'STAGE_BLOCKED' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;
}

export class ListNotificationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: NotificationStatus })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;
  @ApiPropertyOptional({ enum: NotificationChannel })
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;
  @ApiPropertyOptional({ example: 'ORDER_DELIVERED' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;
  @ApiPropertyOptional({ enum: NotificationRecipientKind })
  @IsOptional()
  @IsEnum(NotificationRecipientKind)
  recipientKind?: NotificationRecipientKind;
  @ApiPropertyOptional({ example: '2031-01-01' })
  @IsOptional()
  @Matches(DATE)
  from?: string;
  @ApiPropertyOptional({
    example: '2031-01-31',
    description: 'Inclusive when a plain date',
  })
  @IsOptional()
  @Matches(DATE)
  to?: string;
}

class CategoryPreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  @IsIn([...NOTIFICATION_CATEGORIES])
  category!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  email?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;
}

export class SetMyPreferencesDto {
  @ApiPropertyOptional({
    example: 'ar',
    description: 'Language of your notifications',
  })
  @IsOptional()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  locale?: string;
  @ApiPropertyOptional({ type: [CategoryPreferenceDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CategoryPreferenceDto)
  categories?: CategoryPreferenceDto[];
}

class CustomerCategoryPreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  @IsIn([...NOTIFICATION_CATEGORIES])
  category!: string;
  @ApiProperty()
  @IsBoolean()
  email!: boolean;
  @ApiProperty()
  @IsBoolean()
  whatsapp!: boolean;
}

export class SetCustomerPreferencesDto {
  @ApiPropertyOptional({ example: 'ar', nullable: true })
  @IsOptional()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  preferredLocale?: string;
  @ApiPropertyOptional({ type: [CustomerCategoryPreferenceDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CustomerCategoryPreferenceDto)
  categories?: CustomerCategoryPreferenceDto[];
}

export class ListTemplatesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  code?: string;
  @ApiPropertyOptional({ enum: NotificationChannel })
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;
  @ApiPropertyOptional({ example: 'ar' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
  @ApiPropertyOptional({ description: 'Only active versions' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  activeOnly?: boolean;
}

export class PublishTemplateDto {
  @ApiProperty({ example: 'ORDER_DELIVERED' })
  @Trim()
  @Matches(/^[A-Z][A-Z0-9_]{1,59}$/, {
    message: 'code must be UPPER_SNAKE_CASE',
  })
  code!: string;
  @ApiProperty({ enum: NotificationChannel })
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;
  @ApiProperty({ example: 'ar' })
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/, {
    message: 'locale must look like en or en-GB',
  })
  locale!: string;
  @ApiPropertyOptional({
    description: 'Subject / title (required for IN_APP and EMAIL)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;
  @ApiProperty({
    description: 'Text with {{variable}} placeholders from the supported list',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  bodyTemplate!: string;
}
