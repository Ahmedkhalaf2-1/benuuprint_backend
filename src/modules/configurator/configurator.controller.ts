import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import { ConfiguratorService } from './configurator.service.js';

class OptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
class OptionWithDescriptionDto extends OptionDto {
  @ApiProperty({ nullable: true }) description!: string | null;
}
class ColorOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) hex!: string | null;
  @ApiProperty({ nullable: true }) pantone!: string | null;
}
class FabricOptionDto extends OptionWithDescriptionDto {
  @ApiProperty({ nullable: true }) composition!: string | null;
  @ApiProperty({ nullable: true }) minGsm!: number | null;
  @ApiProperty({ nullable: true }) maxGsm!: number | null;
  @ApiProperty({ nullable: true }) defaultGsm!: number | null;
  @ApiProperty({ type: [ColorOptionDto] }) colors!: ColorOptionDto[];
  @ApiProperty({
    description: 'Product types this fabric is allowed for',
    type: 'array',
    items: { type: 'object' },
  })
  productTypes!: { productTypeId: string; isRecommended: boolean }[];
}
class SizeOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
class SizeScaleOptionDto extends OptionDto {
  @ApiProperty({ type: [SizeOptionDto] }) sizes!: SizeOptionDto[];
}
class PatternOptionDto {
  @ApiProperty({ format: 'uuid' }) patternId!: string;
  @ApiProperty({ example: 'PAT-000001' }) referenceNumber!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) fitType!: string | null;
  @ApiProperty({ format: 'uuid' }) productTypeId!: string;
  @ApiProperty({
    format: 'uuid',
    description:
      'Use this as sample.patternVersionId (the approved current version)',
  })
  patternVersionId!: string;
  @ApiProperty() versionNumber!: number;
}
class PrintMethodOptionDto extends OptionWithDescriptionDto {
  @ApiProperty() type!: string;
  @ApiProperty() supportsFullColor!: boolean;
  @ApiProperty({ nullable: true }) maxColors!: number | null;
  @ApiProperty({ nullable: true }) minQuantity!: number | null;
}
class CategorizedOptionDto extends OptionDto {
  @ApiProperty({ nullable: true }) category!: string | null;
}
class ChoiceDto {
  @ApiProperty() value!: string;
}
class ActiveTermsDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() version!: number;
  @ApiProperty() title!: string;
  @ApiProperty() content!: string;
}
export class SampleOptionsDto {
  @ApiProperty({ type: [OptionWithDescriptionDto] })
  productTypes!: OptionWithDescriptionDto[];
  @ApiProperty({ type: [FabricOptionDto] }) fabrics!: FabricOptionDto[];
  @ApiProperty({ type: [SizeScaleOptionDto] })
  sizeScales!: SizeScaleOptionDto[];
  @ApiProperty({
    type: [PatternOptionDto],
    description: 'Only patterns that have an approved current version',
  })
  patterns!: PatternOptionDto[];
  @ApiProperty({ type: [PrintMethodOptionDto] })
  printMethods!: PrintMethodOptionDto[];
  @ApiProperty({ type: [CategorizedOptionDto] })
  accessories!: CategorizedOptionDto[];
  @ApiProperty({
    type: [CategorizedOptionDto],
    description: 'Labels and packaging',
  })
  components!: CategorizedOptionDto[];
  @ApiProperty({ type: [ChoiceDto] }) fitMethods!: ChoiceDto[];
  @ApiProperty({ type: [ChoiceDto] }) fabricProviders!: ChoiceDto[];
  @ApiProperty({ type: [ChoiceDto] }) decorationSides!: ChoiceDto[];
  @ApiProperty({ type: [ChoiceDto] }) measurementUnits!: ChoiceDto[];
  @ApiProperty({ type: ActiveTermsDto, nullable: true })
  terms!: ActiveTermsDto | null;
}

/**
 * One read-only call with everything a sample form needs. Active records only; no
 * prices, fees, internal notes, reference-number internals or storage details.
 * The customer portal serves a further-reduced projection of the same data from
 * `GET /customer/configurator/sample-options`.
 */
@ApiTags('Configurator')
@Controller('configurator')
export class ConfiguratorController {
  constructor(private readonly configurator: ConfiguratorService) {}

  @Get('sample-options')
  @RequirePermissions('master_data.read')
  @ApiOperation({
    summary:
      'Everything needed to fill in a sample request (read-only, customer-safe)',
  })
  @ApiOkResponse({ type: SampleOptionsDto })
  sampleOptions(): Promise<SampleOptionsDto> {
    return this.configurator.sampleOptions();
  }
}
