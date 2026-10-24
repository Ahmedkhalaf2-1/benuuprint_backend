import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import { CurrentUser } from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { EtaService } from '../management/eta.service.js';
import {
  ProcessProjectionService,
  type JobProcess,
} from '../responsibilities/process-projection.service.js';

const NOTE =
  'Staff data: names of workers and stage owners. Never exposed to the customer portal. Every field comes from real production data (stages, assignments, blockers and the job activity log).';

/** Adds the existing job ETA (only for callers with eta.read) to projected jobs, in one batched call. */
async function withEta<T extends { jobId: string }>(
  eta: EtaService,
  user: AuthUser,
  items: T[],
): Promise<Array<T & { eta: unknown }>> {
  if (!user.permissions.has('eta.read') || items.length === 0) {
    return items.map((i) => ({ ...i, eta: null }));
  }
  const views = await eta.forJobs(items.map((i) => i.jobId));
  return items.map((i) => {
    const v = views.get(i.jobId);
    return {
      ...i,
      eta: v
        ? {
            estimatedCompletionAt: v.estimatedCompletionAt,
            dataQuality: v.dataQuality,
            projectedLate: v.projectedLate,
            projectedLateMinutes: v.projectedLateMinutes,
            blocked: v.blocked,
            onHold: v.onHold,
          }
        : null,
    };
  });
}

@ApiTags('Admin Customer Operations')
@Controller('admin')
export class OperationsController {
  constructor(
    private readonly projection: ProcessProjectionService,
    private readonly eta: EtaService,
  ) {}

  @Get('customers/:customerId/operations')
  @RequirePermissions('responsibilities.read')
  @ApiOperation({
    summary: "A customer's operational picture",
    description: `Active samples, active orders and every live job as one work item: current stage (status, who owns it, assignment source, started/completed times, duration), next stage and its owner, progress, blocker and ETA. Sorted blocked, overdue, in progress, ready, planned; then priority; then job number. ${NOTE}`,
  })
  @ApiOkResponse({ description: 'activeSamples, activeOrders, currentWork' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async customer(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const view = await this.projection.forCustomer(customerId);
    return {
      ...view,
      currentWork: await withEta(this.eta, user, view.currentWork),
    };
  }

  @Get('orders/:orderId/process')
  @RequirePermissions('responsibilities.read')
  @ApiOperation({
    summary: 'Where is this order, who has it, what comes next',
    description: `The complete operational path of an order: one process per production job (whole order or batch) with the full stage timeline, handoffs and ETA. ${NOTE}`,
  })
  @ApiOkResponse({ description: 'order, jobs[] (with stages[]), progress' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async order(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const view = await this.projection.forOrder(orderId);
    return { ...view, jobs: await withEta(this.eta, user, view.jobs) };
  }

  @Get('samples/:sampleId/process')
  @RequirePermissions('responsibilities.read')
  @ApiOperation({
    summary: 'Operational timeline of a sample (production side)',
    description: `The sample's commercial status stays on the sample; this adds who works each production stage and when. ${NOTE}`,
  })
  @ApiOkResponse({ description: 'sample, jobs[] (with stages[]), progress' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async sample(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const view = await this.projection.forSample(sampleId);
    return { ...view, jobs: await withEta(this.eta, user, view.jobs) };
  }

  @Get('jobs/:jobId/process')
  @RequirePermissions('responsibilities.read')
  @ApiOperation({
    summary: 'Operational timeline of one production job',
    description: `Per stage: status, primary owner, additional workers, assignment source (GLOBAL_DEFAULT, CUSTOMER_OVERRIDE, MANUAL, UNASSIGNED), assignedAt/readyAt/startedAt/completedAt, who started and completed it, duration, blocker and the handoff to the next stage and its owner. ${NOTE}`,
  })
  @ApiOkResponse({ description: 'JobProcess' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async job(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobProcess & { eta: unknown }> {
    const p = await this.projection.forJob(jobId);
    return (await withEta(this.eta, user, [p]))[0]!;
  }
}
