import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NormalizeEmail } from '../../../common/transforms.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
} from '../../../common/password-policy.js';

export class LoginDto {
  @ApiProperty({ example: 'admin@example.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token returned by login/refresh' })
  @IsString()
  @MaxLength(300)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({ description: PASSWORD_POLICY_MESSAGE })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message: PASSWORD_POLICY_MESSAGE,
  })
  newPassword!: string;
}

export class AuthProfileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ type: [String], example: ['SALES'] }) roles!: string[];
  @ApiProperty({ type: [String], example: ['customers.read'] })
  permissions!: string[];
}

export class TokenPairDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: 'Bearer';
  @ApiProperty({ description: 'Access token lifetime in seconds' })
  expiresIn!: number;
}

export class LoginResponseDto extends TokenPairDto {
  @ApiProperty({ type: AuthProfileDto }) user!: AuthProfileDto;
}

export class SessionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) userAgent!: string | null;
  @ApiProperty({ nullable: true }) ipAddress!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) lastUsedAt!: Date | null;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() current!: boolean;
}
