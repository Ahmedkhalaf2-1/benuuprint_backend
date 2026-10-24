import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';
import { NormalizeEmail } from '../../../common/transforms.js';

export class CreatePortalAccountDto {
  @ApiProperty({
    description:
      'Login email of the customer for the portal (unique across customers; need not equal the customer record email)',
  })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class PortalAccountDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['INVITED', 'ACTIVE', 'DISABLED'] }) status!: string;
  @ApiProperty({ nullable: true }) lastLoginAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class PortalInvitationDto extends PortalAccountDto {
  @ApiProperty() expiresAt!: Date;
  @ApiPropertyOptional({
    description:
      'Raw one-time token. Present only when EXPOSE_ONE_TIME_TOKENS is on (default outside production). Shown once and never stored.',
  })
  inviteToken?: string;
  @ApiPropertyOptional({
    description:
      'Activation link, when PUBLIC_APP_URL is configured and tokens are exposed',
  })
  inviteUrl?: string;
}
