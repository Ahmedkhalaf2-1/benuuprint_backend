import { ApiProperty } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}
