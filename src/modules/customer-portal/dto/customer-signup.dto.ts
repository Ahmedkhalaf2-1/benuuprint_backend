import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
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
import {
  NormalizeEmail,
  NormalizePhone,
  Trim,
} from '../../../common/transforms.js';
import { PHONE_PATTERN } from '../../customers/dto/customer.dto.js';

const POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

/** Everything a visitor may send. There is deliberately no customerId, status, role or verification field. */
export class RegisterCustomerDto {
  @ApiProperty({ example: 'Amina Yusuf', description: 'Your full name' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'amina@example.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ example: '+201001234567' })
  @IsOptional()
  @NormalizePhone()
  @Matches(PHONE_PATTERN, {
    message: 'phone must be 6-15 digits, optionally starting with +',
  })
  phone?: string;

  @ApiProperty({ description: PASSWORD_POLICY_MESSAGE })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(POLICY, { message: PASSWORD_POLICY_MESSAGE })
  password!: string;

  @ApiProperty({ description: 'Must be true' })
  @IsBoolean()
  @Equals(true, { message: 'You must accept the Terms of Service' })
  acceptedTerms!: boolean;

  @ApiProperty({ description: 'Must be true' })
  @IsBoolean()
  @Equals(true, { message: 'You must accept the Privacy Policy' })
  acceptedPrivacy!: boolean;
}

export class RegisterCustomerResponseDto {
  @ApiProperty({
    enum: ['verification_required', 'registered'],
    description:
      '`verification_required`: check your email. `registered`: verification is switched off, sign in now.',
  })
  status!: 'verification_required' | 'registered';
  @ApiProperty({ example: 'a***@example.com', description: 'Masked address' })
  email!: string;
  @ApiProperty() emailVerificationRequired!: boolean;
}

export class CustomerAuthConfigDto {
  @ApiProperty({
    description:
      'false: register then sign in directly; hide "check your email" and resend-verification UI',
  })
  emailVerificationRequired!: boolean;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'One-time token from the verification link' })
  @IsString()
  @MaxLength(300)
  token!: string;
}

export class VerifyEmailResponseDto {
  @ApiProperty({ enum: ['verified'] })
  status!: 'verified';
}

export class ResendVerificationDto {
  @ApiProperty()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResendVerificationResponseDto {
  @ApiProperty({ description: 'Identical whether or not an account matches' })
  message!: string;
}
