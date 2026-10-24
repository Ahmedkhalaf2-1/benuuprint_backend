import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { ApprovalsService } from '../../approvals/approvals.service.js';
import {
  AssetsService,
  type UploadedFileInput,
} from '../../assets/assets.service.js';
import type { DownloadUrlResponseDto } from '../../assets/dto/asset.dto.js';
import { CommercialService } from '../../commercial/commercial.service.js';
import { D } from '../../commercial/money.js';
import {
  MAX_PENDING_CUSTOMER_PAYMENTS,
  PaymentsService,
} from '../../payments/payments.service.js';
import { SampleProductionSpecService } from '../../samples/sample-production-spec.service.js';
import type {
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
import { projectProduction } from '../samples/customer-sample-production.js';
import { projectQuotations } from './quotation-projection.js';
import {
  paymentSelect,
  toCustomerPayment,
} from './customer-payment-projection.js';
import {
  allowedActions,
  nextCommercialAction,
  paymentStatus,
  type CustomerAction,
} from './customer-commercial.js';

const OPEN_STATUSES = ['SUBMITTED', 'UNDER_REVIEW'] as const;

/**
 * The customer's commercial and approval actions. Everything is the staff domain (quotations, approvals,
 * payments, the commercial gate, the production spec freeze) reached through customer-scoped entry
 * points; this class only proves ownership and projects customer-safe views.
 */
@Injectable()
export class CustomerCommercialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commercial: CommercialService,
    private readonly approvals: ApprovalsService,
    private readonly payments: PaymentsService,
    private readonly assets: AssetsService,
    private readonly specs: SampleProductionSpecService,
  ) {}

  // ---- ownership ---------------------------------------------------------------------------------

  private async ownedSample(me: CustomerPrincipal, id: string) {
    const sample = await this.prisma.sample.findFirst({
      where: { id, customerId: me.customerId, archivedAt: null },
      select: { id: true, status: true, archivedAt: true },
    });
    if (!sample) throw new NotFoundException('Request not found');
    return sample;
  }

  // ---- quotation ---------------------------------------------------------------------------------

  async quotations(
    me: CustomerPrincipal,
    sampleId: string,
  ): Promise<CustomerQuotationsDto> {
    const sample = await this.ownedSample(me, sampleId);
    const quotations = await this.prisma.quotation.findMany({
      where: {
        sampleId,
        // a quotation the customer never received is not theirs to see
        versions: { some: { sentAt: { not: null } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        versions: {
          where: { sentAt: { not: null } },
          orderBy: { versionNumber: 'asc' },
          include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    return projectQuotations(
      quotations,
      (v, now) =>
        sample.status === 'QUOTED' &&
        v.status === 'SENT' &&
        !(v.validUntil && v.validUntil <= now) &&
        !v.invalidatedAt,
    );
  }

  /** Returns the sample id so the controller can answer with the refreshed request. */
  async acceptQuotation(
    me: CustomerPrincipal,
    versionId: string,
    meta: RequestMeta,
  ): Promise<string> {
    const approval = await this.approvals.customerQuotationDecision(
      me.customerId,
      versionId,
      'APPROVED',
      undefined,
      meta,
    );
    return approval.sampleId;
  }

  async rejectQuotation(
    me: CustomerPrincipal,
    versionId: string,
    dto: RejectQuotationDto,
    meta: RequestMeta,
  ): Promise<string> {
    const approval = await this.approvals.customerQuotationDecision(
      me.customerId,
      versionId,
      'REJECTED',
      dto.reason,
      meta,
    );
    return approval.sampleId;
  }

  // ---- payments ----------------------------------------------------------------------------------

  async paymentsOf(
    me: CustomerPrincipal,
    sampleId: string,
  ): Promise<CustomerPaymentsDto> {
    await this.ownedSample(me, sampleId);
    const [summary, rows] = await Promise.all([
      this.paymentSummary(sampleId),
      this.prisma.payment.findMany({
        where: { sampleId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: paymentSelect,
      }),
    ]);
    return {
      summary,
      payments: rows.map((p) => toCustomerPayment(p, me.customerId)),
    };
  }

  async submitPayment(
    me: CustomerPrincipal,
    sampleId: string,
    file: UploadedFileInput | undefined,
    dto: CustomerSubmitPaymentDto,
    meta: RequestMeta,
  ): Promise<CustomerPaymentDto> {
    await this.ownedSample(me, sampleId);
    if (!file) throw new BadRequestException('A proof file is required');
    const proof = await this.assets.uploadForCustomer(
      file,
      { type: 'PAYMENT_PROOF' },
      me.customerId,
      meta,
    );
    try {
      const created = await this.payments.createFor(
        sampleId,
        {
          amount: dto.amount,
          method: dto.method,
          transactionReference: dto.transactionReference,
          receivedAt: dto.receivedAt,
          proofAssetId: proof.id,
        },
        { id: me.customerId, customer: true },
        meta,
      );
      const row = await this.prisma.payment.findUniqueOrThrow({
        where: { id: created.id },
        select: paymentSelect,
      });
      return toCustomerPayment(row, me.customerId);
    } catch (error) {
      await this.discard(proof.id);
      throw error;
    }
  }

  async replaceProof(
    me: CustomerPrincipal,
    paymentId: string,
    file: UploadedFileInput | undefined,
    meta: RequestMeta,
  ): Promise<CustomerPaymentDto> {
    await this.ownedPayment(me, paymentId);
    if (!file) throw new BadRequestException('A proof file is required');
    const proof = await this.assets.uploadForCustomer(
      file,
      { type: 'PAYMENT_PROOF' },
      me.customerId,
      meta,
    );
    try {
      await this.payments.attachProofAsCustomer(
        paymentId,
        me.customerId,
        proof.id,
        meta,
      );
    } catch (error) {
      await this.discard(proof.id);
      throw error;
    }
    const row = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: paymentSelect,
    });
    return toCustomerPayment(row, me.customerId);
  }

  /** Only the proof the customer uploaded themselves can be downloaded again. */
  async proofDownload(
    me: CustomerPrincipal,
    paymentId: string,
    disposition: 'attachment' | 'inline' | undefined,
  ): Promise<DownloadUrlResponseDto> {
    const payment = await this.ownedPayment(me, paymentId);
    if (!payment.proofAssetId) throw new NotFoundException('No proof file');
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: payment.proofAssetId,
        uploadedByCustomerId: me.customerId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!asset) throw new NotFoundException('No proof file');
    return this.assets.downloadUrl(asset.id, disposition);
  }

  private async ownedPayment(me: CustomerPrincipal, id: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id,
        createdByCustomerId: me.customerId,
        OR: [
          { sample: { is: { customerId: me.customerId, archivedAt: null } } },
          { order: { is: { customerId: me.customerId } } },
        ],
      },
      select: { id: true, proofAssetId: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  private async discard(assetId: string): Promise<void> {
    await this.prisma.asset
      .update({ where: { id: assetId }, data: { archivedAt: new Date() } })
      .catch(() => undefined);
  }

  /** The backend's own commercial figures (accepted quotation vs VERIFIED payments), renamed for customers. */
  private async paymentSummary(sampleId: string) {
    const s = await this.commercial.summary(sampleId);
    const state = paymentStatus({
      acceptedTotal: s.acceptedTotal,
      verified: s.verifiedPaid,
      pending: s.pendingPayments,
    });
    return {
      status: state.status,
      currency: s.acceptedTotal === null ? null : s.currency,
      requiredAmount: s.acceptedTotal,
      verifiedAmount: s.verifiedPaid,
      pendingAmount: s.pendingPayments,
      remainingAmount: state.remaining,
    };
  }

  // ---- summary and actions -------------------------------------------------------------------------

  async summary(
    me: CustomerPrincipal,
    sampleId: string,
  ): Promise<CustomerCommercialSummaryDto> {
    const sample = await this.ownedSample(me, sampleId);
    const [payment, quotes, actions] = await Promise.all([
      this.paymentSummary(sampleId),
      this.quotations(me, sampleId),
      this.actionsFor(me, sample, { required: false, accepted: false }),
    ]);
    const all = quotes.quotations.flatMap((q) =>
      q.versions.map((v) => ({ q, v })),
    );
    const head =
      all.find(({ v }) => v.actionable) ??
      all.find(({ v }) => v.status === 'ACCEPTED') ??
      null;
    return {
      sampleId,
      quotation: head
        ? {
            quotationId: head.q.id,
            quotationNumber: head.q.quotationNumber,
            versionId: head.v.id,
            versionNumber: head.v.versionNumber,
            status: head.v.status,
            total: head.v.total,
            currency: head.q.currency,
            validUntil: head.v.validUntil,
            requiresReview: quotes.requiresReview && head.v.actionable,
          }
        : null,
      payment,
      nextAction: nextCommercialAction(actions),
      allowedActions: actions,
    };
  }

  /** The actions open to the customer now, from real backend state (never recreated in the client). */
  async actionsFor(
    me: CustomerPrincipal,
    sample: { id: string; status: string; archivedAt: Date | null },
    terms: { required: boolean; accepted: boolean },
  ): Promise<CustomerAction[]> {
    let actionableQuotation = false;
    let canSubmitPayment = false;
    let sampleApprovable = false;
    if (sample.status === 'QUOTED') {
      const now = new Date();
      actionableQuotation =
        (await this.prisma.quotationVersion.count({
          where: {
            status: 'SENT',
            invalidatedAt: null,
            quotation: { sampleId: sample.id },
            OR: [{ validUntil: null }, { validUntil: { gt: now } }],
          },
        })) > 0;
    } else if (sample.status === 'AWAITING_PAYMENT') {
      const [pay, pending] = await Promise.all([
        this.paymentSummary(sample.id),
        this.prisma.payment.count({
          where: {
            sampleId: sample.id,
            createdByCustomerId: me.customerId,
            status: { in: [...OPEN_STATUSES] },
          },
        }),
      ]);
      const remaining = pay.remainingAmount ? D(pay.remainingAmount) : D(0);
      canSubmitPayment =
        remaining.gt(0) && pending < MAX_PENDING_CUSTOMER_PAYMENTS;
    } else if (sample.status === 'AWAITING_APPROVAL') {
      sampleApprovable =
        (await this.specs.approvalBlockers(sample.id)).length === 0;
    }
    return allowedActions({
      sampleStatus: sample.status,
      archived: !!sample.archivedAt,
      actionableQuotation,
      canSubmitPayment,
      sampleApprovable,
      termsRequired: terms.required,
      termsAccepted: terms.accepted,
    });
  }

  // ---- production --------------------------------------------------------------------------------

  async production(
    me: CustomerPrincipal,
    sampleId: string,
  ): Promise<CustomerProductionDto> {
    await this.ownedSample(me, sampleId);
    // the current physical-sample job: a live one first, else the newest finished one
    const jobs = await this.prisma.factoryJob.findMany({
      where: {
        sampleId,
        sourceType: 'SAMPLE_PRODUCTION',
        status: { not: 'CANCELLED' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        stages: {
          select: { stageCode: true, status: true, supersededAt: true },
        },
      },
    });
    const job = jobs.find((j) => j.status !== 'COMPLETED') ?? jobs[0] ?? null;
    return projectProduction(
      job?.status ?? null,
      (job?.stages ?? []).map((s) => ({
        stageCode: s.stageCode,
        status: s.status,
        superseded: !!s.supersededAt,
      })),
    );
  }

  // ---- sample approval -----------------------------------------------------------------------------

  async approveSample(
    me: CustomerPrincipal,
    sampleId: string,
    dto: ApproveSampleDto,
    meta: RequestMeta,
  ): Promise<void> {
    await this.approvals.customerSampleDecision(
      me.customerId,
      sampleId,
      'APPROVED',
      dto.note,
      meta,
    );
  }

  async requestChanges(
    me: CustomerPrincipal,
    sampleId: string,
    dto: RequestSampleChangesDto,
    meta: RequestMeta,
  ): Promise<void> {
    const categories = [...new Set(dto.categories ?? [])];
    const note = categories.length
      ? `[${categories.join(', ')}] ${dto.reason}`
      : dto.reason;
    await this.approvals.customerSampleDecision(
      me.customerId,
      sampleId,
      'REJECTED',
      note,
      meta,
    );
  }
}
