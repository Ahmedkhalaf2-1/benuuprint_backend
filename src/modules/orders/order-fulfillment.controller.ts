import {
  Body,
  Controller,
  Delete,
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
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  Public,
  RequirePermissions,
} from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { TrackingThrottle } from '../auth/auth-throttle.decorator.js';
import type { UploadedFileInput } from '../assets/assets.service.js';
import { DownloadUrlResponseDto } from '../assets/dto/asset.dto.js';
import {
  PackagingSpecResponseDto,
  UpdatePackagingSpecDto,
} from './dto/packaging.dto.js';
import {
  CreateShipmentDto,
  DeliverShipmentDto,
  DispatchShipmentDto,
  ListMyDeliveriesQueryDto,
  ListShipmentsQueryDto,
  PaginatedShipmentsDto,
  PaginatedStaffDeliveriesDto,
  ShipmentReasonDto,
  ShipmentResponseDto,
  StaffDeliveryDto,
  UpdateShipmentDto,
} from './dto/shipment.dto.js';
import {
  CreateTrackingTokenDto,
  PublicTrackingDto,
  TrackingStatusDto,
  TrackingTokenResponseDto,
} from './dto/tracking.dto.js';
import { OrderCommercialService } from './order-commercial.service.js';
import { OrderPackagingService } from './order-packaging.service.js';
import { OrderTrackingService } from './order-tracking.service.js';
import { OrderCommercialSummaryDto } from './dto/commercial.dto.js';
import { ShipmentsService } from './shipments.service.js';

@ApiTags('Order Packaging')
@Controller('admin')
export class OrderPackagingController {
  constructor(private readonly packaging: OrderPackagingService) {}

  @Get('orders/:id/packaging')
  @RequirePermissions('orders.read')
  @ApiOperation({
    summary:
      'Packaging specification, packed quantities and reconciliation of an order',
  })
  @ApiOkResponse({ type: PackagingSpecResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.packaging.get(id);
  }

  @Put('orders/:id/packaging')
  @RequirePermissions('packaging.manage')
  @ApiOperation({
    summary: 'Define or edit the packaging specification',
    description:
      'Master-data components and custom ones; not once the packaging stage has started. Components, when sent, replace the list.',
  })
  @ApiOkResponse({ type: PackagingSpecResponseDto })
  put(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePackagingSpecDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.packaging.upsert(id, dto, actor, meta);
  }
}

@ApiTags('Order Commercial')
@Controller('admin')
export class OrderCommercialController {
  constructor(private readonly commercial: OrderCommercialService) {}

  @Get('orders/:id/commercial')
  @RequirePermissions('orders.commercial.read')
  @ApiOperation({
    summary:
      'Quotation, payments, payment state and the production release gate of an order',
    description:
      'Computed by the server from the accepted quotation and VERIFIED payments. Factory and delivery roles cannot call this.',
  })
  @ApiOkResponse({ type: OrderCommercialSummaryDto })
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.commercial.summary(id);
  }
}

@ApiTags('Shipments')
@Controller('admin')
export class ShipmentsAdminController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get('orders/:id/shipments')
  @RequirePermissions('shipments.read')
  @ApiOperation({ summary: 'Shipments of an order' })
  @ApiOkResponse({ type: [ShipmentResponseDto] })
  forOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.listForOrder(id);
  }

  @Post('orders/:id/shipments')
  @RequirePermissions('shipments.manage')
  @ApiOperation({
    summary: 'Create a (partial) shipment with variant quantities',
    description:
      'Needs produced and packed units; the destination is copied into an immutable snapshot; units can never be shipped twice (order lock + database trigger).',
  })
  @ApiCreatedResponse({ type: ShipmentResponseDto })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShipmentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.create(id, dto, actor, meta);
  }

  @Get('shipments')
  @RequirePermissions('shipments.read')
  @ApiOperation({ summary: 'All shipments (filters, pagination)' })
  @ApiOkResponse({ type: PaginatedShipmentsDto })
  list(@Query() query: ListShipmentsQueryDto) {
    return this.shipments.list(query);
  }

  @Get('shipments/:id')
  @RequirePermissions('shipments.read')
  @ApiOperation({ summary: 'Get a shipment' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.get(id);
  }

  @Patch('shipments/:id')
  @RequirePermissions('shipments.manage')
  @ApiOperation({
    summary:
      'Edit a shipment (lines only while DRAFT; destination never changes)',
  })
  @ApiOkResponse({ type: ShipmentResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShipmentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.update(id, dto, actor, meta);
  }

  @Post('shipments/:id/ready')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.manage')
  @ApiOperation({
    summary:
      'Mark a DRAFT shipment READY (quantities, packaging and destination re-validated)',
  })
  @ApiOkResponse({ type: ShipmentResponseDto })
  ready(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.transition(id, 'ready', {}, actor, meta);
  }

  @Post('shipments/:id/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.dispatch')
  @ApiOperation({ summary: 'Dispatch a READY (or retry a FAILED) shipment' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchShipmentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.transition(
      id,
      'dispatch',
      { dispatch: dto },
      actor,
      meta,
    );
  }

  @Post('shipments/:id/in-transit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.dispatch')
  @ApiOperation({ summary: 'Mark a dispatched shipment in transit' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  inTransit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.transition(id, 'in-transit', {}, actor, meta);
  }

  @Post('shipments/:id/deliver')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.complete')
  @ApiOperation({ summary: 'Confirm delivery (optional proof asset)' })
  @ApiOkResponse({ type: ShipmentResponseDto })
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverShipmentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.transition(
      id,
      'deliver',
      { deliver: dto },
      actor,
      meta,
    );
  }

  @Post('shipments/:id/fail')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.complete')
  @ApiOperation({
    summary:
      'Record a failed delivery attempt (reason required; can be retried or returned)',
  })
  @ApiOkResponse({ type: ShipmentResponseDto })
  fail(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipmentReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.transition(
      id,
      'fail',
      { reason: dto.reason },
      actor,
      meta,
    );
  }

  @Post('shipments/:id/return')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.complete')
  @ApiOperation({
    summary:
      'Record a return (reason required); its units become shippable again',
  })
  @ApiOkResponse({ type: ShipmentResponseDto })
  returned(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipmentReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.transition(
      id,
      'return',
      { reason: dto.reason },
      actor,
      meta,
    );
  }

  @Post('shipments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.manage')
  @ApiOperation({
    summary: 'Cancel a DRAFT or READY shipment (reason required; history kept)',
  })
  @ApiOkResponse({ type: ShipmentResponseDto })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipmentReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.transition(
      id,
      'cancel',
      { reason: dto.reason },
      actor,
      meta,
    );
  }

  @Post('shipments/:id/proof')
  @RequirePermissions('shipments.complete')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary:
      'Upload a private delivery-proof file (while the shipment is on its way)',
  })
  @ApiCreatedResponse({ type: ShipmentResponseDto })
  proof(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.uploadProof(id, file, actor, meta);
  }

  @Get('shipments/:id/proof-url')
  @RequirePermissions('shipments.read')
  @ApiOperation({
    summary: 'Short-lived signed URL of the delivery proof (never public)',
  })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  proofUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.shipments.proofUrl(id, actor);
  }
}

/** Delivery staff: only deliveries assigned to them, only what they need to deliver. */
@ApiTags('Staff Deliveries')
@Controller('staff')
export class StaffDeliveriesController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get('deliveries')
  @RequirePermissions('deliveries.read_assigned')
  @ApiOperation({ summary: 'My deliveries (open ones by default)' })
  @ApiOkResponse({ type: PaginatedStaffDeliveriesDto })
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListMyDeliveriesQueryDto,
  ) {
    return this.shipments.myDeliveries(actor, query);
  }

  @Get('deliveries/:id')
  @RequirePermissions('deliveries.read_assigned')
  @ApiOperation({
    summary: 'One of my deliveries',
    description:
      'Shipment, recipient, phone, address, package quantities and delivery notes. No quotation, payment, production or audit data.',
  })
  @ApiOkResponse({ type: StaffDeliveryDto })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.shipments.myDelivery(id, actor);
  }

  private act(
    id: string,
    action: Parameters<ShipmentsService['transition']>[1],
    input: Parameters<ShipmentsService['transition']>[2],
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    return this.shipments
      .transition(id, action, input, actor, meta, { assigneeOnly: true })
      .then(() => this.shipments.myDelivery(id, actor));
  }

  @Post('deliveries/:id/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.dispatch')
  @ApiOperation({ summary: 'Dispatch my delivery (picked up for delivery)' })
  @ApiOkResponse({ type: StaffDeliveryDto })
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchShipmentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.act(id, 'dispatch', { dispatch: dto }, actor, meta);
  }

  @Post('deliveries/:id/in-transit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.dispatch')
  @ApiOperation({ summary: 'Mark my delivery in transit' })
  @ApiOkResponse({ type: StaffDeliveryDto })
  inTransit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.act(id, 'in-transit', {}, actor, meta);
  }

  @Post('deliveries/:id/delivered')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.complete')
  @ApiOperation({ summary: 'Confirm that I delivered it' })
  @ApiOkResponse({ type: StaffDeliveryDto })
  delivered(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverShipmentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.act(id, 'deliver', { deliver: dto }, actor, meta);
  }

  @Post('deliveries/:id/failed')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.complete')
  @ApiOperation({ summary: 'Report that delivery failed (reason required)' })
  @ApiOkResponse({ type: StaffDeliveryDto })
  failed(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipmentReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.act(id, 'fail', { reason: dto.reason }, actor, meta);
  }

  @Post('deliveries/:id/returned')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.complete')
  @ApiOperation({
    summary: 'Report that the goods came back (reason required)',
  })
  @ApiOkResponse({ type: StaffDeliveryDto })
  returned(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipmentReasonDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.act(id, 'return', { reason: dto.reason }, actor, meta);
  }

  @Post('deliveries/:id/proof')
  @RequirePermissions('shipments.complete')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Upload a delivery photo / signed receipt (private)',
  })
  @ApiCreatedResponse({ type: StaffDeliveryDto })
  async proof(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.shipments.uploadProof(id, file, actor, meta, {
      assigneeOnly: true,
    });
    return this.shipments.myDelivery(id, actor);
  }

  @Get('deliveries/:id/proof-url')
  @RequirePermissions('deliveries.read_assigned')
  @ApiOperation({ summary: 'Signed URL of the proof I uploaded' })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  proofUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.shipments.proofUrl(id, actor, { assigneeOnly: true });
  }
}

@ApiTags('Order Tracking')
@Controller('admin')
export class OrderTrackingAdminController {
  constructor(private readonly tracking: OrderTrackingService) {}

  @Get('orders/:id/tracking')
  @RequirePermissions('public_tracking.manage')
  @ApiOperation({
    summary:
      'Is customer tracking enabled for this order? (never returns the token)',
  })
  @ApiOkResponse({ type: TrackingStatusDto })
  status(@Param('id', ParseUUIDPipe) id: string) {
    return this.tracking.status(id);
  }

  @Post('orders/:id/tracking-token')
  @RequirePermissions('public_tracking.manage')
  @ApiOperation({
    summary: 'Create the customer tracking link',
    description:
      'Returns the raw token once; only its hash is stored. 409 if a link already exists (use regenerate).',
  })
  @ApiCreatedResponse({ type: TrackingTokenResponseDto })
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTrackingTokenDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tracking.issue(id, dto.expiresInDays, false, actor, meta);
  }

  @Post('orders/:id/tracking-token/regenerate')
  @RequirePermissions('public_tracking.manage')
  @ApiOperation({
    summary:
      'Replace the tracking link: the old token stops working immediately',
  })
  @ApiCreatedResponse({ type: TrackingTokenResponseDto })
  regenerate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTrackingTokenDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tracking.issue(id, dto.expiresInDays, true, actor, meta);
  }

  @Delete('orders/:id/tracking-token')
  @RequirePermissions('public_tracking.manage')
  @ApiOperation({ summary: 'Revoke the tracking link' })
  @ApiOkResponse({ type: TrackingStatusDto })
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tracking.revoke(id, actor, meta);
  }
}

/** Public and unauthenticated by design: the unguessable token is the only credential. */
@ApiTags('Public Tracking')
@Controller('track')
export class PublicTrackingController {
  constructor(private readonly tracking: OrderTrackingService) {}

  @Get('orders/:token')
  @Public()
  @TrackingThrottle()
  @ApiOperation({
    summary: 'Customer-safe order tracking',
    description:
      'Rate-limited per IP. Unknown, revoked and expired tokens return the same generic 404. Shows coarse status, progress, target date and shipment status only: no prices, payments, notes, staff, QC, blockers, phone/email/address or audit data.',
  })
  @ApiOkResponse({ type: PublicTrackingDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Tracking link not found',
  })
  view(@Param('token') token: string) {
    return this.tracking.publicView(token);
  }
}
