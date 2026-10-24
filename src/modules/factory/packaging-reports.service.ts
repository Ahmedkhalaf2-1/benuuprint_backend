import { ConflictException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/types/auth-user.js';
import type { ReportPackagingDto } from './dto/packaging.dto.js';
import type { StageReportsResponseDto } from './dto/quantity.dto.js';
import { StageQuantityService } from './stage-quantity.service.js';

/**
 * Packaging execution. A packaging report is a stage production report (packed = produced,
 * damaged = rejected, so quantities, locks and over-report protection are the same) plus the
 * packaging details (cartons, notes). Append-only; nothing is ever overwritten.
 */
@Injectable()
export class PackagingReportsService {
  constructor(private readonly quantities: StageQuantityService) {}

  report(
    stageId: string,
    dto: ReportPackagingDto,
    actor: AuthUser,
  ): Promise<StageReportsResponseDto> {
    return this.quantities.report(
      stageId,
      {
        producedQuantity: dto.packedQuantity,
        rejectedQuantity: dto.damagedQuantity ?? 0,
        orderVariantId: dto.orderVariantId,
        notes: dto.notes,
      },
      actor,
      async (tx, report, stage, job) => {
        if (stage.departmentType !== 'PACKAGING' || stage.isQcStage) {
          throw new ConflictException(
            'Packaging reports apply to the packaging stage only',
          );
        }
        if (!job.orderId) {
          throw new ConflictException(
            'Packaging reports apply to bulk order jobs only',
          );
        }
        const spec = await tx.orderPackagingSpec.count({
          where: { orderId: job.orderId },
        });
        if (spec === 0) {
          throw new ConflictException(
            'Define the order packaging specification before packaging starts',
          );
        }
        await tx.packagingReport.create({
          data: {
            jobStageId: stage.id,
            stageReportId: report.id,
            packedQuantity: dto.packedQuantity,
            damagedQuantity: dto.damagedQuantity ?? 0,
            cartonCount: dto.cartonCount ?? 0,
            notes: dto.notes?.trim() || null,
            reportedByUserId: actor.id,
          },
        });
      },
    );
  }
}
