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
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ReqMeta } from '../../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import type {
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import type { UploadedFileInput } from '../../assets/assets.service.js';
import { CustomerActionThrottle } from '../../auth/auth-throttle.decorator.js';
import {
  CurrentCustomer,
  CustomerRoute,
} from '../auth/customer-route.decorators.js';
import {
  CustomerPaymentDto,
  CustomerPaymentsDto,
  CustomerQuotationsDto,
  CustomerSubmitPaymentDto,
  RejectQuotationDto,
} from '../dto/customer-commercial.dto.js';
import {
  CustomerCreateOrderDto,
  CustomerOrderActivityDto,
  CustomerOrderCommercialDto,
  CustomerOrderDetailDto,
  CustomerOrderItemsDto,
  CustomerOrderProductionDto,
  CustomerOrderShipmentsDto,
  CustomerReorderDto,
  CustomerShipmentDetailDto,
  CustomerUpdateOrderDto,
  ListCustomerOrdersQueryDto,
  PaginatedCustomerOrdersDto,
} from '../dto/customer-order.dto.js';
import { CustomerOrderTrackingService } from './customer-order-tracking.service.js';
import { CustomerOrdersService } from './customer-orders.service.js';

@ApiTags('Customer Orders')
@CustomerRoute()
@Controller('customer')
export class CustomerOrdersController {
  constructor(private readonly orders: CustomerOrdersService) {}

  @CustomerActionThrottle()
  @Post('samples/:sampleId/create-order')
  @ApiOperation({
    summary: 'Start a bulk order from an approved sample (DRAFT)',
    description:
      "The sample must be yours and approved; the order always produces its approved reference (never the pre-production specification). `items` is optional: one product line with a total and a size / colour breakdown (catalogue sizes and the approved fabric's colours; the lines must add up). The order stays a draft until you submit it; confirmation is done by our team.",
  })
  @ApiCreatedResponse({ type: CustomerOrderDetailDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The sample is not approved or has no approved reference',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  create(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CustomerCreateOrderDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.create(me, sampleId, dto, meta);
  }

  @Get('orders')
  @ApiOperation({
    summary: 'My orders',
    description:
      'Only your own orders. Filter by customer status (comma-separated), search by order number / brand / product, sort and page. The dashboard views (active, in production, awaiting your action, shipped / delivered) are status filters.',
  })
  @ApiOkResponse({ type: PaginatedCustomerOrdersDto })
  list(
    @CurrentCustomer() me: CustomerPrincipal,
    @Query() query: ListCustomerOrdersQueryDto,
  ) {
    return this.orders.list(me, query);
  }

  @Get('orders/:id')
  @ApiOperation({
    summary: 'One of my orders (customer view)',
    description:
      'Status, next step and allowed actions, the approved reference, quantities and size / colour breakdown, commercial and shipping summary. No internal notes, staff, QC, blockers, rework, costs or audit data.',
  })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.get(me, id);
  }

  @Patch('orders/:id')
  @ApiOperation({
    summary: "Edit a draft order's details",
    description:
      'Target delivery date, your notes and your preferred address (one of your own), while the order is still a draft. Status cannot be changed here.',
  })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The order has been submitted',
  })
  update(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CustomerUpdateOrderDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.update(me, id, dto, meta);
  }

  @Put('orders/:id/items')
  @ApiOperation({
    summary: 'Set the quantities and size / colour breakdown of a draft order',
    description:
      'Replaces the product line. Positive whole numbers; the lines must add up to the total; sizes and colours must exist (colours of the approved fabric); the same size / colour cannot appear twice. Only while the order is a draft.',
  })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  replaceItems(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CustomerOrderItemsDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.replaceItems(me, id, dto, meta);
  }

  @CustomerActionThrottle()
  @Post('orders/:id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a draft order to Benue Print',
    description:
      'The order must be complete (quantities add up). It then waits for our team to confirm it; you cannot confirm or release it for production yourself.',
  })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  submit(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.submit(me, id, meta);
  }

  @CustomerActionThrottle()
  @Post('orders/:id/reorder')
  @ApiOperation({
    summary: 'Order the same thing again',
    description:
      'Only for a delivered or completed order whose approved reference is still valid. Creates a NEW draft order from the same approved reference, copying only the quantities and size / colour breakdown; no production state, quotation, payment or decision is copied. Edit and submit it like any draft.',
  })
  @ApiCreatedResponse({ type: CustomerOrderDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  reorder(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CustomerReorderDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.reorder(me, id, dto, meta);
  }

  @Get('orders/:id/commercial')
  @ApiTags('Customer Order Commercial')
  @ApiOperation({
    summary: 'Commercial summary of my order',
    description:
      'Quotation state, the open version you can decide on, payment amounts (required / verified / pending / remaining, one currency), whether the order may go to production, and the next action. `requiresReview` is true when a change to the order made the previous quotation obsolete.',
  })
  @ApiOkResponse({ type: CustomerOrderCommercialDto })
  commercial(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.commercialOf(me, id);
  }

  @Get('orders/:id/quotation')
  @ApiTags('Customer Order Commercial')
  @ApiOperation({
    summary: 'The quotations of my order',
    description:
      'Only versions that were sent to you; superseded and obsolete ones are history (`endedByChange` marks those ended by an order change).',
  })
  @ApiOkResponse({ type: CustomerQuotationsDto })
  quotation(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.quotationsOf(me, id);
  }

  @CustomerActionThrottle()
  @Post('order-quotation-versions/:id/accept')
  @ApiTags('Customer Order Commercial')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an order quotation version',
    description:
      'Only the open (SENT, unexpired, not superseded or obsolete) version. A version made obsolete by an order change can never be accepted.',
  })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  accept(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.decide(me, id, 'accept', undefined, meta);
  }

  @CustomerActionThrottle()
  @Post('order-quotation-versions/:id/reject')
  @ApiTags('Customer Order Commercial')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject an order quotation version' })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  reject(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectQuotationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.decide(me, id, 'reject', dto.reason, meta);
  }

  @Get('orders/:id/payments')
  @ApiTags('Customer Order Commercial')
  @ApiOperation({
    summary: 'Payment state and my payment submissions for an order',
  })
  @ApiOkResponse({ type: CustomerPaymentsDto })
  payments(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.paymentsOf(me, id);
  }

  @CustomerActionThrottle()
  @Post('orders/:id/payments')
  @ApiTags('Customer Order Commercial')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Submit a payment with its proof for an order (multipart)',
    description:
      'Needs an accepted quotation; the amount cannot exceed what is still owed. The payment waits for our finance team to verify it; replace the proof with POST /customer/payments/:id/proof.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'amount', 'method'],
      properties: {
        file: { type: 'string', format: 'binary' },
        amount: { type: 'number' },
        method: {
          type: 'string',
          enum: [
            'INSTAPAY',
            'VODAFONE_CASH',
            'TELDA',
            'BANK_TRANSFER',
            'CASH',
            'OTHER',
          ],
        },
        transactionReference: { type: 'string' },
        receivedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiCreatedResponse({ type: CustomerPaymentDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  submitPayment(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() dto: CustomerSubmitPaymentDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.submitPayment(me, id, file, dto, meta);
  }
}

@ApiTags('Customer Order Tracking')
@CustomerRoute()
@Controller('customer')
export class CustomerOrderTrackingController {
  constructor(private readonly tracking: CustomerOrderTrackingService) {}

  @Get('orders/:id/production')
  @ApiOperation({
    summary: 'Production progress of my order in simple steps',
    description:
      'Seven coarse steps aggregated over every production job (batches included), progress percent, packaging state and an estimated completion with a customer-safe confidence. No staff, stage names, QC, blockers, rework or per-stage quantities.',
  })
  @ApiOkResponse({ type: CustomerOrderProductionDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  production(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracking.production(me, id);
  }

  @Get('orders/:id/shipments')
  @ApiOperation({
    summary: 'Shipments of my order',
    description:
      'Customer states (preparing, on the way, delivered, delivery attempt failed, returned), units per shipment, and the order totals: shipped, delivered, remaining, partially shipped. Drafts and cancelled shipments are hidden; internal failure notes, staff and delivery proof are not exposed.',
  })
  @ApiOkResponse({ type: CustomerOrderShipmentsDto })
  shipments(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracking.shipments(me, id);
  }

  @Get('shipments/:id')
  @ApiOperation({
    summary: 'One of my shipments, with its size / colour lines',
  })
  @ApiOkResponse({ type: CustomerShipmentDetailDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  shipment(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracking.shipment(me, id);
  }

  @Get('orders/:id/activity')
  @ApiOperation({
    summary: 'Customer-safe timeline of my order',
    description:
      'Created, submitted, confirmed, quotation, payment, production, packaging, shipment and delivery steps. Internal events and staff text never appear.',
  })
  @ApiOkResponse({ type: [CustomerOrderActivityDto] })
  activity(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracking.activity(me, id);
  }
}
