import { ApiProperty } from '@nestjs/swagger';
import { TokenPairDto } from '../../auth/dto/auth.dto.js';

export class CustomerIdentityDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUS-000001' }) customerNumber!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
}

export class CustomerLoginResponseDto extends TokenPairDto {
  @ApiProperty({ type: CustomerIdentityDto }) customer!: CustomerIdentityDto;
}

export class CustomerMeDto extends CustomerIdentityDto {
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) whatsapp!: string | null;
  @ApiProperty({ enum: ['ACTIVE'], description: 'Portal account status' })
  accountStatus!: 'ACTIVE';
}
