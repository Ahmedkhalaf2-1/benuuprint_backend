import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
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
  CreateQuotationDto,
  CreateQuotationVersionDto,
  QuotationResponseDto,
  QuotationVersionResponseDto,
  UpdateQuotationVersionDto,
} from './dto/quotation.dto.js';
import { RecordOrderDecisionDto } from '../orders/dto/commercial.dto.js';
import { QuotationsService } from './quotations.service.js';

@ApiTags('Quotations')
@Controller('admin')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get('samples/:sampleId/quotations')
  @RequirePermissions('quotations.read')
  @ApiOperation({
    summary: 'Quotations of a sample, each with its full version history',
  })
  @ApiOkResponse({ type: [QuotationResponseDto] })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  list(@Param('sampleId', ParseUUIDPipe) sampleId: string) {
    return this.quotations.listForSample(sampleId);
  }

  @Post('samples/:sampleId/quotations')
  @RequirePermissions('quotations.create')
  @ApiOperation({
    summary: 'Create a quotation (QTN-…) with its first DRAFT version',
    description:
      'The sample must be UNDER_REVIEW. Line amounts, subtotal, tax and total are calculated by the server. Only one live quotation per sample; use versions to revise.',
  })
  @ApiCreatedResponse({ type: QuotationResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Sample not under review, or a live quotation already exists',
  })
  create(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateQuotationDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.quotations.create(sampleId, dto, actor, meta);
  }

  @Get('orders/:orderId/quotations')
  @RequirePermissions('quotations.read', 'orders.commercial.read')
  @ApiOperation({
    summary: 'Quotations of a bulk order, each with its version history',
  })
  @ApiOkResponse({ type: [QuotationResponseDto] })
  listForOrder(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.quotations.listForOrder(orderId);
  }

  @Post('orders/:orderId/quotations')
  @RequirePermissions('quotations.create', 'orders.commercial.manage')
  @ApiOperation({
    summary: 'Create a quotation for a bulk order',
    description:
      'Same quotation model as samples (versions, Decimal money, explicit currency, immutable once sent). Orders accept quotations before production is released; the customer decision is recorded by staff with evidence.',
  })
  @ApiCreatedResponse({ type: QuotationResponseDto })
  createForOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateQuotationDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.quotations.createForOrder(orderId, dto, actor, meta);
  }

  @Post('order-quotation-versions/:id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.commercial.manage')
  @ApiOperation({
    summary: "Record the customer's acceptance of an order quotation (final)",
    description:
      'The sourceNote is the evidence (e.g. a WhatsApp confirmation). Accepted versions are immutable.',
  })
  @ApiOkResponse({ type: QuotationVersionResponseDto })
  acceptOrderVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordOrderDecisionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.quotations.decideForOrder(
      id,
      'accept',
      dto.sourceNote,
      actor,
      meta,
    );
  }

  @Post('order-quotation-versions/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.commercial.manage')
  @ApiOperation({
    summary: "Record the customer's rejection of an order quotation",
  })
  @ApiOkResponse({ type: QuotationVersionResponseDto })
  rejectOrderVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordOrderDecisionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.quotations.decideForOrder(
      id,
      'reject',
      dto.sourceNote,
      actor,
      meta,
    );
  }

  @Get('quotations/:id')
  @RequirePermissions('quotations.read')
  @ApiOperation({ summary: 'Get a quotation with all versions and line items' })
  @ApiOkResponse({ type: QuotationResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.get(id);
  }

  @Post('quotations/:id/versions')
  @RequirePermissions('quotations.create')
  @ApiOperation({
    summary: 'Create a new version',
    description:
      "Starts from the previous version's lines unless lineItems are given. A SENT predecessor is superseded immediately. Not allowed once a version is ACCEPTED or while a DRAFT is open.",
  })
  @ApiCreatedResponse({ type: QuotationVersionResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateQuotationVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.quotations.createVersion(id, dto, actor, meta);
  }

  @Get('quotation-versions/:id')
  @RequirePermissions('quotations.read')
  @ApiOperation({ summary: 'Get one quotation version' })
  @ApiOkResponse({ type: QuotationVersionResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getVersion(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.getVersion(id);
  }

  @Patch('quotation-versions/:id')
  @RequirePermissions('quotations.create')
  @ApiOperation({
    summary: 'Edit a DRAFT version (lineItems replaces the whole list)',
  })
  @ApiOkResponse({ type: QuotationVersionResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Only DRAFT versions are editable',
  })
  updateVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuotationVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.quotations.updateVersion(id, dto, actor, meta);
  }

  @Post('quotation-versions/:id/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('quotations.create')
  @ApiOperation({
    summary: 'Send a DRAFT version to the customer',
    description:
      'DRAFT → SENT. The first send also moves the sample UNDER_REVIEW → QUOTED. The version becomes immutable.',
  })
  @ApiOkResponse({ type: QuotationVersionResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'No line items, or validUntil in the past',
  })
  @ApiConflictResponse({ type: ErrorResponseDto })
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.quotations.send(id, actor, meta);
  }
}
