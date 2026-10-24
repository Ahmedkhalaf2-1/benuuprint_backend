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
  ApiNoContentResponse,
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
import {
  DownloadUrlQueryDto,
  DownloadUrlResponseDto,
} from '../../assets/dto/asset.dto.js';
import { CustomerActionThrottle } from '../../auth/auth-throttle.decorator.js';
import {
  CreateDecorationDto,
  CreateSampleAccessoryDto,
  CreateSampleComponentDto,
  UpdateDecorationDto,
  UpdateSampleAccessoryDto,
  UpdateSampleComponentDto,
} from '../../samples/dto/sample-spec.dto.js';
import {
  SampleAccessoryDto,
  SampleComponentDto,
  SampleDecorationDto,
} from '../../samples/dto/sample.dto.js';
import {
  CurrentCustomer,
  CustomerRoute,
} from '../auth/customer-route.decorators.js';
import {
  AcceptCustomerTermsDto,
  CustomerActivityEventDto,
  CustomerCreateSampleDto,
  CustomerFileDto,
  CustomerMessageDto,
  CustomerSampleDetailDto,
  CustomerTermsAcceptanceDto,
  CustomerTermsDto,
  CustomerUpdateSampleDto,
  CustomerUploadFileDto,
  ListCustomerSamplesQueryDto,
  PaginatedCustomerSamplesDto,
  SubmissionCheckDto,
} from '../dto/customer-sample.dto.js';
import { CustomerSamplesService } from './customer-samples.service.js';

@ApiTags('Customer Samples')
@CustomerRoute()
@Controller('customer/samples')
export class CustomerSamplesController {
  constructor(private readonly samples: CustomerSamplesService) {}

  @Get()
  @ApiOperation({
    summary: 'My sample requests',
    description:
      'Only your own requests. Filter by customer status, search by number / brand / product, sort and page.',
  })
  @ApiOkResponse({ type: PaginatedCustomerSamplesDto })
  list(
    @CurrentCustomer() me: CustomerPrincipal,
    @Query() query: ListCustomerSamplesQueryDto,
  ) {
    return this.samples.list(me, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Start a sample request (DRAFT)',
    description:
      'Only brandId is required; everything else can be filled in later. The owner is always the signed-in customer. Use productTypeId OR customProductName, fabricId OR customFabricName, fabricColorId OR custom colour fields.',
  })
  @ApiCreatedResponse({ type: CustomerSampleDetailDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  create(
    @CurrentCustomer() me: CustomerPrincipal,
    @Body() dto: CustomerCreateSampleDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.create(me, dto, meta);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One of my requests (customer view)',
    description:
      'Specification, files, terms state, customer status and next step. No internal notes, staff, QC, factory or cost data.',
  })
  @ApiOkResponse({ type: CustomerSampleDetailDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.samples.get(me, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a draft request',
    description:
      'Drafts only (including a request returned for changes). Omitted = unchanged, null = clear. Status cannot be changed here: use submit.',
  })
  @ApiOkResponse({ type: CustomerSampleDetailDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The request has been submitted',
  })
  update(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CustomerUpdateSampleDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.update(me, id, dto, meta);
  }

  @Get(':id/submission-check')
  @ApiOperation({
    summary: 'What is still missing before this draft can be submitted',
  })
  @ApiOkResponse({ type: SubmissionCheckDto })
  submissionCheck(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.samples.submissionCheck(me, id);
  }

  @CustomerActionThrottle()
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit the request to Benue Print',
    description:
      'Runs the full completeness validation (all problems are reported together) and requires the active sample terms to be accepted. The request then appears as a new request for our team.',
  })
  @ApiOkResponse({ type: CustomerSampleDetailDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'The request is incomplete (message lists every problem)',
  })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  submit(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.submit(me, id, meta);
  }

  @Get(':id/activity')
  @ApiOperation({
    summary: 'Customer-safe status timeline',
    description:
      'One entry per change you can tell apart. Internal events (holds, assignments, notes, reviews) are not shown.',
  })
  @ApiOkResponse({ type: [CustomerActivityEventDto] })
  activity(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.samples.activity(me, id);
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'Messages from the team (read-only)',
    description: 'Only notes the team explicitly marked as visible to you.',
  })
  @ApiOkResponse({ type: [CustomerMessageDto] })
  messages(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.samples.messages(me, id);
  }

  // ---- specification parts (drafts only) --------------------------------------------------

  @Post(':id/decorations')
  @ApiOperation({ summary: 'Add a print / embroidery placement' })
  @ApiCreatedResponse({ type: SampleDecorationDto })
  createDecoration(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDecorationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.createDecoration(me, id, dto, meta);
  }

  @Patch(':id/decorations/:decorationId')
  @ApiOperation({ summary: 'Edit a placement' })
  @ApiOkResponse({ type: SampleDecorationDto })
  updateDecoration(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('decorationId', ParseUUIDPipe) decorationId: string,
    @Body() dto: UpdateDecorationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.updateDecoration(me, id, decorationId, dto, meta);
  }

  @Delete(':id/decorations/:decorationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a placement' })
  @ApiNoContentResponse()
  removeDecoration(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('decorationId', ParseUUIDPipe) decorationId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.removeDecoration(me, id, decorationId, meta);
  }

  @Post(':id/accessories')
  @ApiOperation({ summary: 'Add an accessory' })
  @ApiCreatedResponse({ type: SampleAccessoryDto })
  createAccessory(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSampleAccessoryDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.createAccessory(me, id, dto, meta);
  }

  @Patch(':id/accessories/:accessoryId')
  @ApiOperation({ summary: 'Edit an accessory' })
  @ApiOkResponse({ type: SampleAccessoryDto })
  updateAccessory(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accessoryId', ParseUUIDPipe) accessoryId: string,
    @Body() dto: UpdateSampleAccessoryDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.updateAccessory(me, id, accessoryId, dto, meta);
  }

  @Delete(':id/accessories/:accessoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an accessory' })
  @ApiNoContentResponse()
  removeAccessory(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accessoryId', ParseUUIDPipe) accessoryId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.removeAccessory(me, id, accessoryId, meta);
  }

  @Post(':id/components')
  @ApiOperation({ summary: 'Add a label / packaging component' })
  @ApiCreatedResponse({ type: SampleComponentDto })
  createComponent(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSampleComponentDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.createComponent(me, id, dto, meta);
  }

  @Patch(':id/components/:componentId')
  @ApiOperation({ summary: 'Edit a component' })
  @ApiOkResponse({ type: SampleComponentDto })
  updateComponent(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('componentId', ParseUUIDPipe) componentId: string,
    @Body() dto: UpdateSampleComponentDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.updateComponent(me, id, componentId, dto, meta);
  }

  @Delete(':id/components/:componentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a component' })
  @ApiNoContentResponse()
  removeComponent(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('componentId', ParseUUIDPipe) componentId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.removeComponent(me, id, componentId, meta);
  }

  // ---- terms -------------------------------------------------------------------------------

  @CustomerActionThrottle()
  @Post(':id/terms/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept the sample terms for this draft',
    description:
      'Recorded as an authenticated customer acceptance of the exact version (time, IP and device included).',
  })
  @ApiOkResponse({ type: CustomerTermsAcceptanceDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  acceptTerms(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptCustomerTermsDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.acceptTerms(me, id, dto, meta);
  }

  // ---- files -------------------------------------------------------------------------------

  @Get(':id/files')
  @ApiTags('Customer Assets')
  @ApiOperation({ summary: 'Files I uploaded to this request' })
  @ApiOkResponse({ type: [CustomerFileDto] })
  files(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.samples.listOwnFiles(me, id);
  }

  @CustomerActionThrottle()
  @Post(':id/files')
  @ApiTags('Customer Assets')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary:
      'Upload a reference, artwork or size chart (multipart, drafts only)',
    description:
      "Content is identified by magic bytes (png, jpeg, gif, webp, pdf); the client type and extension are ignored. Stored privately. With type ARTWORK and a decorationId the file becomes a version of that placement's artwork.",
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        type: {
          type: 'string',
          enum: ['REFERENCE', 'ARTWORK', 'SIZE_CHART', 'OTHER'],
        },
        description: { type: 'string' },
        decorationId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiCreatedResponse({ type: CustomerFileDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  uploadFile(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() dto: CustomerUploadFileDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.uploadFile(me, id, file, dto, meta);
  }

  @Delete(':id/files/:attachmentId')
  @ApiTags('Customer Assets')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove one of my files (drafts only)' })
  @ApiNoContentResponse()
  removeFile(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.removeFile(me, id, attachmentId, meta);
  }

  @Get(':id/files/:attachmentId/download-url')
  @ApiTags('Customer Assets')
  @ApiOperation({
    summary: 'Short-lived private download link for one of my files',
  })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  downloadUrl(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query() query: DownloadUrlQueryDto,
  ) {
    return this.samples.downloadUrl(me, id, attachmentId, query.disposition);
  }
}

@ApiTags('Customer Samples')
@CustomerRoute()
@Controller('customer/terms')
export class CustomerTermsController {
  constructor(private readonly samples: CustomerSamplesService) {}

  @Get('sample')
  @ApiOperation({ summary: 'The currently active sample terms' })
  @ApiOkResponse({ type: CustomerTermsDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  sampleTerms() {
    return this.samples.activeTerms();
  }
}
