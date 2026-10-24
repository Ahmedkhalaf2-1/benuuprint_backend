import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ConfiguratorService } from '../configurator/configurator.service.js';
import { SampleOptionsDto } from '../configurator/configurator.controller.js';
import { CustomerRoute } from './auth/customer-route.decorators.js';

class CustomerPatternOptionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Use as patternVersionId (with fitMethod BENUE_PATTERN)',
  })
  patternVersionId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) fitType!: string | null;
  @ApiProperty({ format: 'uuid' }) productTypeId!: string;
}

export type CustomerSampleOptionsDto = Omit<SampleOptionsDto, 'patterns'> & {
  patterns: CustomerPatternOptionDto[];
};

/**
 * The staff configurator behind the customer principal, one step narrower: patterns are reduced to a
 * friendly name plus the approved version id (no reference numbers or codes, no drafts or superseded
 * versions: the source only ever lists the current APPROVED version of an active pattern).
 */
@ApiTags('Customer Configurator')
@CustomerRoute()
@Controller('customer/configurator')
export class CustomerConfiguratorController {
  constructor(private readonly configurator: ConfiguratorService) {}

  @Get('sample-options')
  @ApiOperation({
    summary: 'Everything needed to fill in a sample request',
    description:
      'Active catalogue only. No prices, fees, internal notes, archived records, pattern internals or storage details.',
  })
  @ApiOkResponse({
    description:
      'Same shape as GET /configurator/sample-options, with reduced pattern entries',
    type: SampleOptionsDto,
  })
  async sampleOptions(): Promise<CustomerSampleOptionsDto> {
    const options = await this.configurator.sampleOptions();
    return Object.assign({}, options, {
      patterns: options.patterns.map((p) => ({
        patternVersionId: p.patternVersionId,
        name: p.name,
        fitType: p.fitType,
        productTypeId: p.productTypeId,
      })),
    });
  }
}
