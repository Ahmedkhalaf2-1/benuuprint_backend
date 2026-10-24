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
  CreatePaymentDto,
  PaymentResponseDto,
  RejectPaymentDto,
  UpdatePaymentDto,
} from './dto/payment.dto.js';
import { PaymentsService } from './payments.service.js';

const transitionNote = () =>
  ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      'The payment is already decided or the sample cannot take payments',
  });

@ApiTags('Payments')
@Controller('admin')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('samples/:sampleId/payments')
  @RequirePermissions('payments.read')
  @ApiOperation({ summary: 'Payments recorded for a sample' })
  @ApiOkResponse({ type: [PaymentResponseDto] })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  list(@Param('sampleId', ParseUUIDPipe) sampleId: string) {
    return this.payments.listForSample(sampleId);
  }

  @Get('orders/:orderId/payments')
  @RequirePermissions('payments.read', 'orders.commercial.read')
  @ApiOperation({ summary: 'Payments recorded for a bulk order' })
  @ApiOkResponse({ type: [PaymentResponseDto] })
  listForOrder(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.payments.listForOrder(orderId);
  }

  @Post('orders/:orderId/payments')
  @RequirePermissions('payments.manage', 'orders.commercial.read')
  @ApiOperation({
    summary: 'Record a payment against the accepted quotation of an order',
    description:
      'Overpayment policy: a payment can never exceed the remaining balance of the accepted quotation. Verification (a different person, payments.verify) moves the order payment state; verify/reject/cancel use the shared /admin/payments/:id endpoints.',
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  createForOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreatePaymentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.createForOrder(orderId, dto, actor, meta);
  }

  @Post('samples/:sampleId/payments')
  @RequirePermissions('payments.manage')
  @ApiOperation({
    summary: 'Record a payment (PAY-…) against the accepted quotation',
    description:
      'Requires an accepted quotation. The amount cannot exceed the remaining balance. The payment starts SUBMITTED; finance verifies it. Upload proof first (asset type PAYMENT_PROOF) and pass proofAssetId.',
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description:
      'Over-payment, bad currency/proof, or card-number-like reference',
  })
  @transitionNote()
  create(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreatePaymentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.create(sampleId, dto, actor, meta);
  }

  @Get('payments/:id')
  @RequirePermissions('payments.read')
  @ApiOperation({ summary: 'Get a payment' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(id);
  }

  @Patch('payments/:id')
  @RequirePermissions('payments.manage')
  @ApiOperation({
    summary:
      'Correct a SUBMITTED payment (amount, method, reference, proof, received date)',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @transitionNote()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.update(id, dto, actor, meta);
  }

  @Post('payments/:id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.verify')
  @ApiOperation({ summary: 'SUBMITTED → UNDER_REVIEW' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @transitionNote()
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.startReview(id, actor, meta);
  }

  @Post('payments/:id/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.verify')
  @ApiOperation({
    summary: 'Verify a payment',
    description:
      'Counts toward the balance. Cannot be done by the person who recorded the payment, and cannot push verified payments above the quotation total. When verified payments cover the total, the sample moves AWAITING_PAYMENT → READY_FOR_PRODUCTION.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'Insufficient permission, or you recorded this payment',
  })
  @transitionNote()
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.verify(id, actor, meta);
  }

  @Post('payments/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.verify')
  @ApiOperation({ summary: 'Reject a payment (reason required)' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @transitionNote()
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectPaymentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.reject(
      id,
      dto.reason,
      actor,
      meta,
      dto.customerMessage,
    );
  }

  @Post('payments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.manage')
  @ApiOperation({
    summary: 'Cancel an undecided payment (recorded by mistake)',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  @transitionNote()
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.cancel(id, actor, meta);
  }
}
