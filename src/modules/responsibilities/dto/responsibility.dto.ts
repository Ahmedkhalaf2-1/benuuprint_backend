import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export const STAGE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export class SetResponsibilityDto {
  @ApiProperty({ format: 'uuid', description: 'The primary owner' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Extra eligible workers added next to the primary owner',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  additionalUserIds?: string[];
}

export const APPLY_MODES = ['UNASSIGNED_ONLY', 'REPLACE'] as const;
export type ApplyMode = (typeof APPLY_MODES)[number];

export class ApplyActiveDto {
  @ApiPropertyOptional({
    enum: APPLY_MODES,
    default: 'UNASSIGNED_ONLY',
    description:
      'UNASSIGNED_ONLY: fill only open stages nobody owns. REPLACE: also replace the owners of stages that have not started yet. Started, completed and closed work is never touched.',
  })
  @IsOptional()
  @IsIn(APPLY_MODES)
  mode?: ApplyMode;
}

export class BulkCustomerOverridesDto {
  @ApiProperty({ type: [String], description: '1–200 customers' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  customerIds!: string[];

  @ApiProperty({ example: 'CUTTING' })
  @IsString()
  @Matches(STAGE_KEY_PATTERN)
  stageKey!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Omit (or leave empty) together with `clear: true` to remove',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  additionalUserIds?: string[];

  @ApiPropertyOptional({
    description: 'true: clear the override of the selected customers',
  })
  @IsOptional()
  clear?: boolean;
}

export class UserRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class ResponsibilityRuleDto {
  @ApiProperty({ enum: ['GLOBAL', 'CUSTOMER'] }) scope!: 'GLOBAL' | 'CUSTOMER';
  @ApiProperty({ nullable: true, format: 'uuid' }) customerId!: string | null;
  @ApiProperty({ example: 'CUTTING' }) stageKey!: string;
  @ApiProperty({ type: UserRefDto }) primaryUser!: UserRefDto;
  @ApiProperty({ type: [UserRefDto] }) additionalUsers!: UserRefDto[];
  @ApiProperty({ enum: ['OK', 'NEEDS_ATTENTION'] })
  health!: 'OK' | 'NEEDS_ATTENTION';
  @ApiProperty({
    nullable: true,
    enum: ['ASSIGNEE_DISABLED', 'ASSIGNEE_INELIGIBLE'],
  })
  reason!: string | null;
  @ApiProperty() updatedAt!: Date;
}

export class ResponsibilityAreaDto {
  @ApiProperty({
    example: 'CUTTING',
    description: 'Stable stage definition code, or DELIVERY',
  })
  stageKey!: string;
  @ApiProperty({ example: 'Cutting' }) label!: string;
  @ApiProperty({ enum: ['FACTORY', 'FULFILLMENT'] }) group!:
    'FACTORY' | 'FULFILLMENT';
  @ApiProperty({
    type: [String],
    description:
      'Roles whose holders may own this area (empty: any staff who can run stages)',
  })
  eligibleRoleCodes!: string[];
}

export class ResponsibilityOverviewItemDto extends ResponsibilityAreaDto {
  @ApiProperty({ type: ResponsibilityRuleDto, nullable: true })
  globalDefault!: ResponsibilityRuleDto | null;
  @ApiProperty({ type: UserRefDto, nullable: true })
  effectiveUser!: UserRefDto | null;
  @ApiProperty({ enum: ['GLOBAL_DEFAULT', 'UNASSIGNED'] })
  source!: string;
  @ApiProperty({ enum: ['OK', 'NEEDS_ATTENTION', 'NOT_CONFIGURED'] })
  health!: string;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty({
    description:
      'Open stages (or live shipments) the effective owner holds right now',
  })
  activeWork!: number;
}

export class CustomerResponsibilityItemDto extends ResponsibilityAreaDto {
  @ApiProperty({ enum: ['CUSTOMER_OVERRIDE', 'GLOBAL_DEFAULT', 'UNASSIGNED'] })
  source!: string;
  @ApiProperty({ type: UserRefDto, nullable: true })
  effectiveUser!: UserRefDto | null;
  @ApiProperty({ type: UserRefDto, nullable: true })
  globalDefaultUser!: UserRefDto | null;
  @ApiProperty({ type: UserRefDto, nullable: true })
  customerOverrideUser!: UserRefDto | null;
  @ApiProperty({ enum: ['OK', 'NEEDS_ATTENTION', 'NOT_CONFIGURED'] })
  health!: string;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty({
    description:
      'Open stages (or live shipments) the effective owner holds right now',
  })
  activeWork!: number;
}
