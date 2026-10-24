import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: 400 }) statusCode!: number;
  @ApiProperty({ example: 'Bad Request' }) error!: string;
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message!: string | string[];
  @ApiProperty({ example: '/api/v1/auth/login' }) path!: string;
  @ApiProperty() timestamp!: string;
  @ApiProperty({ required: false }) requestId?: string;
}
