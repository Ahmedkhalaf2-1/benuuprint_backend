import type {
  FactoryJobStatus,
  JobStageStatus,
} from '../../../generated/prisma/client.js';
import { SATISFIED_STAGE_STATUSES } from './job-stage-state-machine.js';

export interface StageSummary {
  status: JobStageStatus;
  isRequired: boolean;
  supersededAt: Date | null;
}

export interface JobStatusInput {
  stages: StageSummary[];
  openJobBlockers: number;
  hasStarted: boolean;
}

export interface DerivedJobStatus {
  status: Exclude<FactoryJobStatus, 'ON_HOLD' | 'CANCELLED'>;
}

/**
 * The job's high-level status is a summary of its CURRENT stages (rework supersedes
 * earlier occurrences) and open blockers. It never replaces stage-level state.
 * Hold and cancellation are explicit actions handled outside this function.
 */
export function deriveJobStatus(input: JobStatusInput): DerivedJobStatus {
  const current = input.stages.filter((s) => !s.supersededAt);
  const required = current.filter((s) => s.isRequired);
  if (
    current.length > 0 &&
    required.length > 0 &&
    required.every((s) => SATISFIED_STAGE_STATUSES.includes(s.status))
  ) {
    return { status: 'COMPLETED' };
  }
  if (
    input.openJobBlockers > 0 ||
    current.some((s) => s.status === 'BLOCKED')
  ) {
    return { status: 'BLOCKED' };
  }
  if (
    input.hasStarted ||
    current.some((s) => s.status === 'IN_PROGRESS' || s.status === 'COMPLETED')
  ) {
    return { status: 'IN_PROGRESS' };
  }
  if (current.some((s) => s.status === 'READY')) return { status: 'READY' };
  return { status: 'PLANNED' };
}
