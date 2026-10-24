import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Trim } from '../../../common/transforms.js';

export class ListRolesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches name or code' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ListPermissionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 100 })
  override pageSize: number = 100;
}

export class CreateRoleDto {
  @ApiProperty({ example: 'Warehouse Lead' })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: 'WAREHOUSE_LEAD',
    description: 'UPPER_SNAKE_CASE, immutable',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/, {
    message:
      'code must be UPPER_SNAKE_CASE, 2-50 characters, starting with a letter',
  })
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ type: [String], example: ['customers.read'] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissionCodes?: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetRolePermissionsDto {
  @ApiProperty({
    type: [String],
    description: "Replaces the role's full permission set",
    example: ['customers.read', 'samples.read'],
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissionCodes!: string[];
}

export class RoleResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: [String] }) permissions!: string[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedRolesDto {
  @ApiProperty({ type: [RoleResponseDto] }) data!: RoleResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class PermissionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'users.manage' }) code!: string;
  @ApiProperty() description!: string;
}

export class PaginatedPermissionsDto {
  @ApiProperty({ type: [PermissionResponseDto] })
  data!: PermissionResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
