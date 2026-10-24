import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  CurrentCustomer,
  CustomerRoute,
} from '../auth/customer-route.decorators.js';
import {
  ApproveSampleDto,
  CustomerCommercialSummaryDto,
  CustomerPaymentDto,
  CustomerPaymentsDto,
  CustomerProductionDto,
  CustomerQuotationsDto,
  CustomerSubmitPaymentDto,
  RejectQuotationDto,
  RequestSampleChangesDto,
} from '../dto/customer-commercial.dto.js';
import { CustomerSampleDetailDto } from '../dto/customer-sample.dto.js';
import { CustomerSamplesService } from '../samples/customer-samples.service.js';
import { CustomerCommercialService } from './customer-commercial.service.js';

@ApiTags('Customer Commercial')
@CustomerRoute()
@Controller('customer')
export class CustomerCommercialController {
  constructor(
    private readonly commercial: CustomerCommercialService,
    private readonly samples: CustomerSamplesService,
  ) {}

  @Get('samples/:id/commercial')
  @ApiOperation({
    summary: 'Commercial summary of my request',
    description:
      "Quotation state, payment state and the next thing to do, from the backend's own figures. No internal pricing or finance data.",
  })
  @ApiOkResponse({ type: CustomerCommercialSummaryDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  summary(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.summary(me, id);
  }

  @Get('samples/:id/quotation')
  @ApiOperation({
    summary: 'The quotations of my request',
    description:
      'Only versions that were sent to you (never drafts), newest last, with line items and totals. `actionableVersionId` is the one open offer you can accept or reject. No costs, margins or internal notes.',
  })
  @ApiOkResponse({ type: CustomerQuotationsDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  quotation(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.quotations(me, id);
  }

  @CustomerActionThrottle()
  @Post('quotation-versions/:id/accept')
  @ApiTags('Customer Approvals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a quotation version',
    description:
      'Only the open (SENT, unexpired, not superseded) version can be accepted. Recorded as an authenticated customer approval; the request then moves to payment.',
  })
  @ApiOkResponse({ type: CustomerSampleDetailDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Not open: draft, superseded, expired, already decided',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  async accept(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    const sampleId = await this.commercial.acceptQuotation(me, id, meta);
    return this.samples.get(me, sampleId);
  }

  @CustomerActionThrottle()
  @Post('quotation-versions/:id/reject')
  @ApiTags('Customer Approvals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a quotation version',
    description:
      'The quotation and its history are kept; our team is told and can send a new version.',
  })
  @ApiOkResponse({ type: CustomerSampleDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async reject(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectQuotationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    const sampleId = await this.commercial.rejectQuotation(me, id, dto, meta);
    return this.samples.get(me, sampleId);
  }

  // ---- payments ------------------------------------------------------------------------------

  @Get('samples/:id/payments')
  @ApiOperation({
    summary: 'Payment state and my payment submissions',
    description:
      "Required, verified, pending and remaining amounts (one currency: the quotation's), and each of your payments with its verification state. Verification is done by our team.",
  })
  @ApiOkResponse({ type: CustomerPaymentsDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  payments(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.paymentsOf(me, id);
  }

  @CustomerActionThrottle()
  @Post('samples/:id/payments')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Submit a payment with its proof (multipart)',
    description:
      'Creates a payment waiting for verification. The amount cannot exceed what is still owed on the accepted quotation. You can never mark a payment verified.',
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
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  submitPayment(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() dto: CustomerSubmitPaymentDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.commercial.submitPayment(me, id, file, dto, meta);
  }

  @CustomerActionThrottle()
  @Post('payments/:id/proof')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Replace the proof of one of my payments (multipart)',
    description:
      'Only your own payment, and only until our team has started reviewing it.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: CustomerPaymentDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  replaceProof(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.commercial.replaceProof(me, id, file, meta);
  }

  @Get('payments/:id/proof/download-url')
  @ApiOperation({ summary: 'Short-lived download link for my payment proof' })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  proofUrl(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadUrlQueryDto,
  ) {
    return this.commercial.proofDownload(me, id, query.disposition);
  }

  // ---- production and approval -----------------------------------------------------------------

  @Get('samples/:id/production')
  @ApiOperation({
    summary: 'Progress of my sample in simple steps',
    description:
      'Six coarse steps (preparing materials … sample ready). No staff, stage names, quality checklists, blockers, rework or quantities.',
  })
  @ApiOkResponse({ type: CustomerProductionDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  production(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.production(me, id);
  }

  @CustomerActionThrottle()
  @Post('samples/:id/approve')
  @ApiTags('Customer Approvals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve the finished sample',
    description:
      'Only while the sample is awaiting your approval. Recorded as an authenticated customer approval; the approved specification is frozen as the reference for bulk production. Cannot be repeated.',
  })
  @ApiOkResponse({ type: CustomerSampleDetailDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The sample is not awaiting approval (or already approved)',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async approve(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveSampleDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.commercial.approveSample(me, id, dto, meta);
    return this.samples.get(me, id);
  }

  @CustomerActionThrottle()
  @Post('samples/:id/request-changes')
  @ApiTags('Customer Approvals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send the finished sample back with the changes you want',
    description:
      'Only while the sample is awaiting your approval. The previous production job, specification, approvals and artwork history are kept; our team reviews your note and builds the sample again.',
  })
  @ApiOkResponse({ type: CustomerSampleDetailDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async requestChanges(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestSampleChangesDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.commercial.requestChanges(me, id, dto, meta);
    return this.samples.get(me, id);
  }
}
