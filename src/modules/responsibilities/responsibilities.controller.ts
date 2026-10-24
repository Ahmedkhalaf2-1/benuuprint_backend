import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  PipeTransform,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import {
  BulkCustomerOverridesDto,
  CustomerResponsibilityItemDto,
  ResponsibilityOverviewItemDto,
  ResponsibilityRuleDto,
  SetResponsibilityDto,
  STAGE_KEY_PATTERN,
} from './dto/responsibility.dto.js';
import { ResponsibilityRulesService } from './responsibility-rules.service.js';

/** Stage keys are machine codes (stage definition code or DELIVERY), never display names. */
export class ParseStageKeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!STAGE_KEY_PATTERN.test(value)) {
      throw new BadRequestException(
        'stageKey must be an upper-case code like CUTTING',
      );
    }
    return value;
  }
}

const STAGE_KEY = new ParseStageKeyPipe();

@ApiTags('Admin Responsibilities')
@Controller('admin/responsibilities')
export class ResponsibilitiesController {
  constructor(private readonly rules: ResponsibilityRulesService) {}

  @Get()
  @RequirePermissions('responsibilities.read')
  @ApiOperation({
    summary: 'Global default responsibility for every operational area',
    description:
      'One row per area (assignable production stage codes plus DELIVERY): the configured default, who it resolves to, its health and how many open stages that person holds. Areas without a rule are `NOT_CONFIGURED`: their work stays unassigned.',
  })
  @ApiOkResponse({ type: [ResponsibilityOverviewItemDto] })
  overview() {
    return this.rules.overview();
  }

  @Get('attention')
  @RequirePermissions('responsibilities.read')
  @ApiOperation({
    summary:
      'Command-centre feed: rules that need attention and unassigned active work',
    description:
      'Rules pointing at disabled or ineligible people, and open stages (ready, in progress or blocked) that nobody owns, grouped by stage key.',
  })
  attention() {
    return this.rules.attention();
  }

  @Put(':stageKey')
  @RequirePermissions('responsibilities.manage')
  @ApiOperation({
    summary: 'Set the global default owner of an area',
    description:
      'Affects FUTURE work only. Existing stages keep their owners until you call apply-active. The owner must be eligible exactly as for a manual stage assignment (active, may run stages, holds an eligible role).',
  })
  @ApiOkResponse({ type: ResponsibilityRuleDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  set(
    @Param('stageKey', STAGE_KEY) stageKey: string,
    @Body() dto: SetResponsibilityDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.rules.setRule('GLOBAL', null, stageKey, dto, actor, meta);
  }

  @Delete(':stageKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('responsibilities.manage')
  @ApiOperation({
    summary:
      'Clear the global default of an area (future work is left unassigned)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async clear(
    @Param('stageKey', STAGE_KEY) stageKey: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.rules.clearRule('GLOBAL', null, stageKey, actor, meta);
  }

  @Post('bulk-customer-overrides')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('responsibilities.manage')
  @ApiOperation({
    summary: 'Set or clear one area override for many customers',
    description:
      'Body `{ customerIds, stageKey, userId }` sets the override for all of them; `{ customerIds, stageKey, clear: true }` removes it. All-or-nothing, one audit entry with the affected count.',
  })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  bulk(
    @Body() dto: BulkCustomerOverridesDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.rules.bulkCustomerOverrides(dto, actor, meta);
  }
}

@ApiTags('Admin Responsibilities')
@Controller('admin/customers/:customerId/responsibilities')
export class CustomerResponsibilitiesController {
  constructor(private readonly rules: ResponsibilityRulesService) {}

  @Get()
  @RequirePermissions('responsibilities.read')
  @ApiOperation({
    summary: "A customer's responsibility matrix",
    description:
      "For every area: the effective owner, where it comes from (`CUSTOMER_OVERRIDE`, `GLOBAL_DEFAULT` or `UNASSIGNED`), the global default, the customer override, health and the owner's open workload. Precedence is resolved here, never by the client.",
  })
  @ApiOkResponse({ type: [CustomerResponsibilityItemDto] })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  matrix(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.rules.customerMatrix(customerId);
  }

  @Put(':stageKey')
  @RequirePermissions('responsibilities.manage')
  @ApiOperation({
    summary: 'Override the owner of an area for this customer only',
    description: "Affects this customer's FUTURE work only.",
  })
  @ApiOkResponse({ type: ResponsibilityRuleDto })
  set(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('stageKey', STAGE_KEY) stageKey: string,
    @Body() dto: SetResponsibilityDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.rules.setRule(
      'CUSTOMER',
      customerId,
      stageKey,
      dto,
      actor,
      meta,
    );
  }

  @Delete(':stageKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('responsibilities.manage')
  @ApiOperation({
    summary: 'Remove the override (falls back to the global default)',
  })
  @ApiNoContentResponse()
  async clear(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('stageKey', STAGE_KEY) stageKey: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.rules.clearRule('CUSTOMER', customerId, stageKey, actor, meta);
  }
}
