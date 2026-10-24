import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/paginated-meta.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ example: 'user.created' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ example: 'User' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound (ISO-8601)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Inclusive upper bound (ISO-8601)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class AuditLogResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) actorUserId!: string | null;
  @ApiProperty() action!: string;
  @ApiProperty() entityType!: string;
  @ApiProperty({ nullable: true }) entityId!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true }) ipAddress!: string | null;
  @ApiProperty({ nullable: true }) userAgent!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogResponseDto] }) data!: AuditLogResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}
