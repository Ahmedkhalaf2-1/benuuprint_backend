import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
  DecisionDto,
  QuotationVersionResponseDto,
} from '../quotations/dto/quotation.dto.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { ApprovalsService } from './approvals.service.js';
import {
  ApprovalResponseDto,
  RequestApprovalDto,
  RespondApprovalDto,
} from './dto/approval.dto.js';

const conflict = () =>
  ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Already decided, expired, superseded or in the wrong state',
  });

@ApiTags('Approvals')
@Controller('admin')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('samples/:sampleId/approvals')
  @RequirePermissions('samples.read')
  @ApiOperation({ summary: 'Approval requests and decisions for a sample' })
  @ApiOkResponse({ type: [ApprovalResponseDto] })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  list(@Param('sampleId', ParseUUIDPipe) sampleId: string) {
    return this.approvals.listForSample(sampleId);
  }

  @Post('samples/:sampleId/approvals')
  @RequirePermissions('approvals.manage')
  @ApiOperation({
    summary:
      'Open an approval request (QUOTATION, ARTWORK, SAMPLE or PRODUCTION_SPEC)',
    description:
      'QUOTATION needs a SENT version, ARTWORK a DRAFT artwork version, SAMPLE a sample that is AWAITING_APPROVAL, PRODUCTION_SPEC a frozen specification. SAMPLE and PRODUCTION_SPEC also need samples.approve. Only one pending request per target.',
  })
  @ApiCreatedResponse({ type: ApprovalResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @conflict()
  request(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: RequestApprovalDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.approvals.request(sampleId, dto, actor, meta);
  }

  @Post('approvals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('approvals.manage')
  @ApiOperation({
    summary: 'Record an approval',
    description:
      'Recorded by staff (on behalf of the customer, with a source note, or as an internal sign-off). Effects happen in the same transaction: quotation accepted (sample → AWAITING_PAYMENT), artwork version approved (previous approved version superseded), sample approved (frozen production spec created, sample → APPROVED).',
  })
  @ApiOkResponse({ type: ApprovalResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Missing source note, or INTERNAL not allowed for this type',
  })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @conflict()
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondApprovalDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.approvals.approve(id, dto, actor, meta);
  }

  @Post('approvals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('approvals.manage')
  @ApiOperation({
    summary:
      'Record a rejection (quotation rejected, artwork version rejected, produced sample sent back to rework)',
  })
  @ApiOkResponse({ type: ApprovalResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @conflict()
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondApprovalDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.approvals.reject(id, dto, actor, meta);
  }

  @Post('approvals/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('approvals.manage')
  @ApiOperation({ summary: 'Withdraw a pending approval request' })
  @ApiOkResponse({ type: ApprovalResponseDto })
  @conflict()
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.approvals.cancel(id, actor, meta);
  }
}

/** Accept/reject shortcuts for quotations: they open and answer the QUOTATION approval in one step. */
@ApiTags('Quotations')
@Controller('admin/quotation-versions/:id')
export class QuotationDecisionController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly quotations: QuotationsService,
  ) {}

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('approvals.manage')
  @ApiOperation({
    summary: "Record the customer's acceptance of a SENT quotation version",
    description:
      'Needs a source note (how the customer accepted). The version becomes ACCEPTED and immutable, the sample moves QUOTED → AWAITING_PAYMENT, and payments can be recorded. Superseded or expired versions cannot be accepted.',
  })
  @ApiOkResponse({ type: QuotationVersionResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @conflict()
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.approvals.recordQuotationDecision(
      id,
      'APPROVED',
      Object.assign({ recordedAs: 'ON_BEHALF_OF_CUSTOMER' as const }, dto),
      actor,
      meta,
    );
    return this.quotations.getVersion(id);
  }

  @Post('reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('approvals.manage')
  @ApiOperation({
    summary: "Record the customer's rejection of a SENT quotation version",
    description:
      'The sample returns to UNDER_REVIEW so a new version can be prepared.',
  })
  @ApiOkResponse({ type: QuotationVersionResponseDto })
  @conflict()
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.approvals.recordQuotationDecision(
      id,
      'REJECTED',
      Object.assign({ recordedAs: 'ON_BEHALF_OF_CUSTOMER' as const }, dto),
      actor,
      meta,
    );
    return this.quotations.getVersion(id);
  }
}
