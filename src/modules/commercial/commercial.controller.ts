import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import {
  CommercialService,
  type CommercialSummary,
} from './commercial.service.js';

class SummaryQuotationDto {
  @ApiProperty({ format: 'uuid' }) quotationId!: string;
  @ApiProperty({ example: 'QTN-000001' }) quotationNumber!: string;
  @ApiProperty({ format: 'uuid' }) versionId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty() status!: string;
  @ApiProperty({ example: '1500.00' }) total!: string;
}

class SummaryCountsDto {
  @ApiProperty() verified!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() rejected!: number;
  @ApiProperty() cancelled!: number;
}

export class CommercialSummaryDto {
  @ApiProperty({ format: 'uuid' }) sampleId!: string;
  @ApiProperty({ example: 'SMP-000001' }) sampleNumber!: string;
  @ApiProperty({ nullable: true, example: 'EGP' }) currency!: string | null;
  @ApiProperty({ type: SummaryQuotationDto, nullable: true })
  quotation!: SummaryQuotationDto | null;
  @ApiProperty({
    nullable: true,
    example: '1500.00',
    description:
      'Total of the accepted version, else of the latest sent version',
  })
  quotedTotal!: string | null;
  @ApiProperty({
    nullable: true,
    example: '1500.00',
    description: 'Total of the accepted quotation version',
  })
  acceptedTotal!: string | null;
  @ApiProperty({
    example: '500.00',
    description: 'Sum of VERIFIED payments against the accepted quotation',
  })
  verifiedPaid!: string;
  @ApiProperty({
    example: '0.00',
    description: 'Submitted / under-review payments (not counted as paid)',
  })
  pendingPayments!: string;
  @ApiProperty({
    nullable: true,
    example: '1000.00',
    description: 'acceptedTotal − verifiedPaid (never negative)',
  })
  remaining!: string | null;
  @ApiProperty({ enum: ['UNPAID', 'PARTIALLY_PAID', 'PAID'] }) paymentState!:
    'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  @ApiProperty({ type: SummaryCountsDto }) counts!: SummaryCountsDto;
}

@ApiTags('Samples')
@Controller('admin/samples/:id/commercial-summary')
export class CommercialController {
  constructor(private readonly commercial: CommercialService) {}

  @Get()
  @RequirePermissions('quotations.read', 'payments.read')
  @ApiOperation({
    summary:
      'Backend-calculated quoted total, verified payments and remaining balance',
    description:
      'All figures are computed on the server from the accepted quotation and verified payments.',
  })
  @ApiOkResponse({ type: CommercialSummaryDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  summary(@Param('id', ParseUUIDPipe) id: string): Promise<CommercialSummary> {
    return this.commercial.summary(id);
  }
}
