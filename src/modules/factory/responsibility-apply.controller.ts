import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { ApplyActiveDto } from '../responsibilities/dto/responsibility.dto.js';
import { ParseStageKeyPipe } from '../responsibilities/responsibilities.controller.js';
import { StageAutoAssignService } from './stage-auto-assign.service.js';

const STAGE_KEY = new ParseStageKeyPipe();

const DESCRIPTION =
  'Applies the current rules to work that already exists. `UNASSIGNED_ONLY` (default) only fills open stages nobody owns. `REPLACE` also replaces the owners of stages that have not started yet (waiting, ready or blocked). Stages already in progress, completed, cancelled or superseded stages and closed jobs are never touched. For DELIVERY it assigns live shipments (replacing never touches a shipment already on the road). Needs responsibilities.manage and jobs.assign.';

@ApiTags('Admin Responsibilities')
@Controller('admin')
export class ResponsibilityApplyController {
  constructor(private readonly autoAssign: StageAutoAssignService) {}

  @Post('responsibilities/:stageKey/apply-active')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('responsibilities.manage', 'jobs.assign')
  @ApiOperation({
    summary:
      'Apply the responsibility of an area to active work (every customer)',
    description: DESCRIPTION,
  })
  @ApiOkResponse({
    description: 'Counts of assigned, replaced and skipped stages',
  })
  apply(
    @Param('stageKey', STAGE_KEY) stageKey: string,
    @Body() dto: ApplyActiveDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.autoAssign.applyActive(
      stageKey,
      dto.mode ?? 'UNASSIGNED_ONLY',
      null,
      actor,
      meta,
    );
  }

  @Post('customers/:customerId/responsibilities/:stageKey/apply-active')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('responsibilities.manage', 'jobs.assign')
  @ApiOperation({
    summary: "Apply an area's responsibility to one customer's active work",
    description: DESCRIPTION,
  })
  @ApiOkResponse({
    description: 'Counts of assigned, replaced and skipped stages',
  })
  applyForCustomer(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('stageKey', STAGE_KEY) stageKey: string,
    @Body() dto: ApplyActiveDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.autoAssign.applyActive(
      stageKey,
      dto.mode ?? 'UNASSIGNED_ONLY',
      customerId,
      actor,
      meta,
    );
  }
}
