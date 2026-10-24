import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
} from '../../../common/password-policy.js';
import { NormalizeEmail } from '../../../common/transforms.js';

const POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

export class ForgotPasswordDto {
  @ApiProperty()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ForgotPasswordResponseDto {
  @ApiProperty({ description: 'Identical whether or not the account exists' })
  message!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'One-time token from the reset link' })
  @IsString()
  @MaxLength(300)
  token!: string;

  @ApiProperty({ description: PASSWORD_POLICY_MESSAGE })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(POLICY, { message: PASSWORD_POLICY_MESSAGE })
  newPassword!: string;
}

export class AcceptInvitationDto {
  @ApiProperty({ description: 'One-time invitation token' })
  @IsString()
  @MaxLength(300)
  token!: string;

  @ApiProperty({ description: PASSWORD_POLICY_MESSAGE })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(POLICY, { message: PASSWORD_POLICY_MESSAGE })
  password!: string;
}
