import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
  AssignSalesDto,
  OptionalReasonDto,
  ReasonDto,
  SampleDetailResponseDto,
} from './dto/sample.dto.js';
import { SampleWorkflowService } from './sample-workflow.service.js';

const ok = () => ApiOkResponse({ type: SampleDetailResponseDto });
const conflict = () =>
  ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The action is not allowed from the current status',
  });

/**
 * Status changes are named actions validated by the state machine; there is no
 * "set status" endpoint. Commercial consequences (quote sent/accepted, payment
 * covered, approval recorded) happen automatically from their own endpoints.
 */
@ApiTags('Samples')
@Controller('admin/samples/:id')
export class SampleWorkflowController {
  constructor(private readonly workflow: SampleWorkflowService) {}

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.submit')
  @ApiOperation({
    summary: 'DRAFT → SUBMITTED',
    description:
      'Validates completeness (product, fabric, colour, size, fit/pattern rules, decorations and artwork, accepted terms). All problems are returned together as a 400 message list.',
  })
  @ok()
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Specification incomplete: message lists every problem',
  })
  @conflict()
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.submit(id, actor, meta);
  }

  @Post('review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.review')
  @ApiOperation({
    summary: 'SUBMITTED → UNDER_REVIEW (start the internal review)',
  })
  @ok()
  @conflict()
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.start(id, actor, meta);
  }

  @Post('request-changes')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.review')
  @ApiOperation({
    summary: 'SUBMITTED | UNDER_REVIEW → DRAFT (send back for revision)',
    description:
      'Reopens the specification for editing. A reason (the missing information) is required.',
  })
  @ok()
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Reason missing',
  })
  @conflict()
  requestChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.requestChanges(id, dto.reason, actor, meta);
  }

  @Post('hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.review')
  @ApiOperation({
    summary: 'In-flight status → ON_HOLD (remembers the previous status)',
  })
  @ok()
  @conflict()
  hold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.hold(id, dto.reason, actor, meta);
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.review')
  @ApiOperation({ summary: 'ON_HOLD → the status it was held from' })
  @ok()
  @conflict()
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OptionalReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.resume(id, dto.reason, actor, meta);
  }

  @Post('reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.review')
  @ApiOperation({
    summary: '→ REJECTED (terminal)',
    description:
      'From SUBMITTED, UNDER_REVIEW, QUOTED, AWAITING_PAYMENT or ON_HOLD. A reason is required.',
  })
  @ok()
  @conflict()
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.reject(id, dto.reason, actor, meta);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: '→ CANCELLED (terminal)',
    description:
      'From DRAFT through READY_FOR_PRODUCTION, or ON_HOLD. Once production started, put the sample on hold first. The audit entry records any payment already verified.',
  })
  @ok()
  @conflict()
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.cancel(id, dto.reason, actor, meta);
  }

  @Post('start-production')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.manage')
  @ApiOperation({
    deprecated: true,
    summary: 'DEPRECATED. READY_FOR_PRODUCTION → IN_PRODUCTION',
    description:
      'Legacy Phase 3 stand-in. The factory job is the official production system: POST /admin/samples/:id/create-factory-job performs this transition. Refused with 409 when the sample has any factory job. Planned removal: once no deployment relies on job-less sample production (Phase 6 review).',
  })
  @ok()
  @conflict()
  startProduction(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.startProduction(id, actor, meta);
  }

  @Post('finish-production')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.manage')
  @ApiOperation({
    deprecated: true,
    summary:
      'DEPRECATED. IN_PRODUCTION → AWAITING_APPROVAL (the produced sample awaits customer approval)',
    description:
      'Legacy Phase 3 stand-in. Completing the sample-production factory job performs this transition automatically. Refused with 409 when the sample has any factory job. Planned removal together with start-production.',
  })
  @ok()
  @conflict()
  finishProduction(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.finishProduction(id, actor, meta);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'APPROVED → COMPLETED (terminal)' })
  @ok()
  @conflict()
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.complete(id, actor, meta);
  }

  @Post('assign-sales')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('samples.assign')
  @ApiOperation({
    summary: 'Assign (or clear) the sales owner',
    description:
      'Commercial ownership only. The user must be active and hold samples.manage.',
  })
  @ok()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  assignSales(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignSalesDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.workflow.assignSales(id, dto.userId, actor, meta);
  }
}
