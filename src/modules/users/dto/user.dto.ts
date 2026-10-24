import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
} from '../../../common/password-policy.js';
import { NormalizeEmail, Trim } from '../../../common/transforms.js';
import { UserStatus } from '../../../generated/prisma/client.js';

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches name, email or phone' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ example: 'SALES', description: 'Role code' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  role?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

export class CreateUserDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({
    description: `${PASSWORD_POLICY_MESSAGE}. Without a password the user is created as INVITED and cannot log in.`,
  })
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_POLICY_MESSAGE })
  password?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  roleIds?: string[];
}

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'null clears the phone number',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Trim()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({
    description: `Admin password reset. Revokes the user's sessions and activates an INVITED user. ${PASSWORD_POLICY_MESSAGE}`,
  })
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_POLICY_MESSAGE })
  password?: string;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class SetUserRolesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: "Replaces the user's full role set",
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  roleIds!: string[];
}

export class UserRoleSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

/** Never contains passwordHash. */
export class UserResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ nullable: true }) lastLoginAt!: Date | null;
  @ApiProperty({ nullable: true }) passwordChangedAt!: Date | null;
  @ApiProperty({ type: [UserRoleSummaryDto] }) roles!: UserRoleSummaryDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class UserDetailResponseDto extends UserResponseDto {
  @ApiProperty({
    type: [String],
    description: 'Effective permissions (union of active roles)',
  })
  permissions!: string[];
}

export class PaginatedUsersDto {
  @ApiProperty({ type: [UserResponseDto] }) data!: UserResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class InvitationResponseDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiPropertyOptional({
    description:
      'Raw one-time token. Present only when EXPOSE_ONE_TIME_TOKENS is on (default outside production). It is shown once and never stored.',
  })
  inviteToken?: string;
  @ApiPropertyOptional({
    description:
      'Accept link, when PUBLIC_APP_URL is configured and tokens are exposed',
  })
  inviteUrl?: string;
}
