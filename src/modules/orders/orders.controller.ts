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
} from '@nestjs/common';
import {
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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { BulkJobsService } from '../factory/bulk-jobs.service.js';
import {
  CreateFactoryJobDto,
  FactoryJobDetailDto,
} from '../factory/dto/factory-job.dto.js';
import {
  ChangeOrderPriorityDto,
  ForceCompleteOrderDto,
  CreateOrderBatchDto,
  CreateOrderDto,
  ListOrdersQueryDto,
  OrderBatchResponseDto,
  OrderDetailDto,
  OrderReasonDto,
  OrderRevisionResponseDto,
  PaginatedOrderActivitiesDto,
  PaginatedOrdersDto,
  ProductionSummaryDto,
  ReorderDto,
  ReplaceBatchAllocationsDto,
  ReplaceOrderItemsDto,
  ReviseOrderDto,
  UpdateOrderDto,
} from './dto/order.dto.js';
import { OrderBatchesService } from './order-batches.service.js';
import { OrdersService } from './orders.service.js';

@ApiTags('Orders')
@Controller('admin')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly bulkJobs: BulkJobsService,
  ) {}

  @Post('samples/:sampleId/create-order')
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary: 'Create a DRAFT bulk order from an approved sample',
    description:
      "Pins the sample's APPROVED_REFERENCE (never the pre-production spec). Requires an approved sample, a valid reference hash and an active customer and brand.",
  })
  @ApiCreatedResponse({ type: OrderDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateOrderDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.createFromSample(sampleId, dto, actor, meta);
  }

  @Get('orders')
  @RequirePermissions('orders.read')
  @ApiOperation({ summary: 'List orders (search, filters, pagination)' })
  @ApiOkResponse({ type: PaginatedOrdersDto })
  list(@Query() query: ListOrdersQueryDto) {
    return this.orders.list(query);
  }

  @Get('orders/:id')
  @RequirePermissions('orders.read')
  @ApiOperation({
    summary:
      'Order detail: parties, source sample, approved reference, items, variants, batches, jobs and production summary',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.orders.get(id, actor);
  }

  @Patch('orders/:id')
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary: 'Update target delivery date, sales owner or internal notes',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.update(id, dto, actor, meta);
  }

  @Put('orders/:id/items')
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary: 'Replace the items and size / colour variants of a DRAFT order',
    description:
      'Rows with an id are updated in place, rows without are created, missing rows are removed. Totals are verified on the server at confirmation.',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  items(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceOrderItemsDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.replaceItems(id, dto.items, actor, meta);
  }

  @Patch('orders/:id/priority')
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Change priority (live factory jobs inherit it)' })
  @ApiOkResponse({ type: OrderDetailDto })
  priority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeOrderPriorityDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.changePriority(
      id,
      dto.priority,
      dto.reason,
      actor,
      meta,
    );
  }

  @Post('orders/:id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Submit a DRAFT for confirmation' })
  @ApiOkResponse({ type: OrderDetailDto })
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.submit(id, actor, meta);
  }

  @Post('orders/:id/request-changes')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary: 'Send a pending order back to DRAFT (reason required)',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  requestChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.requestChanges(id, dto.reason, actor, meta);
  }

  @Post('orders/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.confirm')
  @ApiOperation({
    summary: 'Confirm the order and freeze its production specification',
    description:
      'Verifies items, variant totals (computed on the server) and the approved reference, then freezes the order production spec. A confirmed order is only changed through revisions.',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.confirm(id, actor, meta);
  }

  @Post('orders/:id/revise')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary: 'Revise a confirmed order (history preserved)',
    description:
      'Quantities / variants can change only before production starts and while no batch or job exists. After production starts only the target date and notes can be revised.',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  revise(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviseOrderDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.revise(id, dto, actor, meta);
  }

  @Post('orders/:id/ready')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary: 'Release a confirmed order for production planning',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  ready(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.markReady(id, actor, meta);
  }

  @Post('orders/:id/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  @ApiOperation({
    summary: 'Close a DELIVERED order',
    description:
      'Needs every deliverable unit delivered, no open shipment and (when a quotation was accepted) full payment. Production finishing is not enough.',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.complete(id, actor, meta);
  }

  @Post('orders/:id/force-complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.override')
  @ApiOperation({
    summary:
      'Admin override: close an order that skipped the normal delivery path',
    description:
      'Reason mandatory; audited; only from production-complete or later.',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  forceComplete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ForceCompleteOrderDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.forceComplete(id, dto.reason, actor, meta);
  }

  @Post('orders/:id/hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Hold an order (floor work on its jobs stops)' })
  @ApiOkResponse({ type: OrderDetailDto })
  hold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.hold(id, dto.reason, actor, meta);
  }

  @Post('orders/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  @ApiOperation({ summary: 'Resume a held order' })
  @ApiOkResponse({ type: OrderDetailDto })
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.resume(id, actor, meta);
  }

  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.cancel')
  @ApiOperation({
    summary: 'Cancel an order (reason required; production history is kept)',
  })
  @ApiOkResponse({ type: OrderDetailDto })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.cancel(id, dto.reason, actor, meta);
  }

  @Post('orders/:id/reorder')
  @RequirePermissions('orders.reorder')
  @ApiOperation({
    summary:
      'Create a reorder (new DRAFT linked to this order, same approved reference)',
    description:
      'Optionally clones the quantities and size / colour breakdown. Never copies jobs, QC, payments or batches. Changes to fabric, construction, fit, pattern, print method or artwork need a new sample.',
  })
  @ApiCreatedResponse({ type: OrderDetailDto })
  reorder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.reorder(id, dto, actor, meta);
  }

  @Get('orders/:id/production-summary')
  @RequirePermissions('orders.read')
  @ApiTags('Production Quantities')
  @ApiOperation({ summary: 'Quantity-aware production progress of an order' })
  @ApiOkResponse({ type: ProductionSummaryDto })
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.productionSummary(id);
  }

  @Get('orders/:id/activities')
  @RequirePermissions('orders.read')
  @ApiOperation({ summary: 'Order timeline (oldest first)' })
  @ApiOkResponse({ type: PaginatedOrderActivitiesDto })
  activities(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.orders.activities(id, query.page, query.pageSize);
  }

  @Get('orders/:id/revisions')
  @RequirePermissions('orders.read')
  @ApiOperation({ summary: 'Revision history of a confirmed order' })
  @ApiOkResponse({ type: [OrderRevisionResponseDto] })
  revisions(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.revisions(id);
  }

  @Get('orders/:id/production-specs')
  @RequirePermissions('orders.read')
  @ApiOperation({
    summary: 'Frozen order production specifications (every revision)',
  })
  productionSpecs(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.productionSpecs(id);
  }

  @Post('orders/:id/create-factory-job')
  @RequirePermissions('factory_jobs.manage')
  @ApiTags('Factory Jobs')
  @ApiOperation({
    summary: 'Create the BULK_ORDER factory job that produces the whole order',
    description:
      'Needs a READY_FOR_PRODUCTION order with a frozen order spec, no batches and no other live job. Pins the APPROVED_REFERENCE and the frozen order spec.',
  })
  @ApiCreatedResponse({ type: FactoryJobDetailDto })
  createJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFactoryJobDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.bulkJobs.createForOrder(id, dto, actor, meta);
  }
}

@ApiTags('Order Batches')
@Controller('admin')
export class OrderBatchesController {
  constructor(
    private readonly batches: OrderBatchesService,
    private readonly bulkJobs: BulkJobsService,
  ) {}

  @Get('orders/:id/batches')
  @RequirePermissions('order_batches.read')
  @ApiOperation({ summary: 'Batches of an order with allocations and jobs' })
  @ApiOkResponse({ type: [OrderBatchResponseDto] })
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.batches.listForOrder(id);
  }

  @Post('orders/:id/batches')
  @RequirePermissions('order_batches.manage')
  @ApiOperation({
    summary: 'Plan a production batch from variant allocations',
    description:
      'The sum of allocations to a variant across non-cancelled batches can never exceed the variant quantity (enforced by the database, also under concurrency).',
  })
  @ApiCreatedResponse({ type: OrderBatchResponseDto })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateOrderBatchDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.batches.create(id, dto, actor, meta);
  }

  @Get('order-batches/:id')
  @RequirePermissions('order_batches.read')
  @ApiOperation({ summary: 'Get one batch' })
  @ApiOkResponse({ type: OrderBatchResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.batches.get(id);
  }

  @Put('order-batches/:id/allocations')
  @RequirePermissions('order_batches.manage')
  @ApiOperation({ summary: 'Replace the allocations of a PLANNED batch' })
  @ApiOkResponse({ type: OrderBatchResponseDto })
  allocations(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceBatchAllocationsDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.batches.replaceAllocations(id, dto, actor, meta);
  }

  @Post('order-batches/:id/ready')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order_batches.manage')
  @ApiOperation({
    summary: 'Mark a PLANNED batch READY (allocation validated)',
  })
  @ApiOkResponse({ type: OrderBatchResponseDto })
  ready(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.batches.markReady(id, actor, meta);
  }

  @Post('order-batches/:id/hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order_batches.manage')
  @ApiOperation({ summary: 'Hold a batch' })
  @ApiOkResponse({ type: OrderBatchResponseDto })
  hold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.batches.hold(id, dto.reason, actor, meta);
  }

  @Post('order-batches/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order_batches.manage')
  @ApiOperation({ summary: 'Resume a held batch' })
  @ApiOkResponse({ type: OrderBatchResponseDto })
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.batches.resume(id, actor, meta);
  }

  @Post('order-batches/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order_batches.manage')
  @ApiOperation({
    summary: 'Cancel a batch (frees its allocation; a live job is cancelled)',
  })
  @ApiOkResponse({ type: OrderBatchResponseDto })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.batches.cancel(id, dto.reason, actor, meta);
  }

  @Post('order-batches/:id/create-factory-job')
  @RequirePermissions('factory_jobs.manage')
  @ApiTags('Factory Jobs')
  @ApiOperation({
    summary: 'Create the ORDER_BATCH factory job for a READY batch',
    description: 'Never overlaps a whole-order job; one live job per batch.',
  })
  @ApiCreatedResponse({ type: FactoryJobDetailDto })
  createJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFactoryJobDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.bulkJobs.createForBatch(id, dto, actor, meta);
  }
}
