import {
  ALL_PERMISSION_CODES,
  type PermissionCode,
} from '../../../common/enums/permissions.js';
import {
  SYSTEM_ROLE_CODES,
  type SystemRoleCode,
} from '../../../common/enums/system-roles.js';

export interface SystemRoleDefinition {
  code: SystemRoleCode;
  name: string;
  description: string;
  /** Union of every grant batch (what a freshly created role receives). */
  permissions: readonly PermissionCode[];
}

/**
 * Default grants are delivered in versioned batches. The seed applies each
 * batch to existing roles exactly once (tracked in `seed_grant_batches`), so a
 * new phase can hand new permissions to system roles without overwriting
 * permissions an admin deliberately removed. Never edit a shipped batch; add a
 * new one. SUPER_ADMIN is not listed: it always receives every permission.
 */
export interface GrantBatch {
  key: string;
  grants: Partial<Record<SystemRoleCode, readonly PermissionCode[]>>;
}

const STAGE_WORKER: readonly PermissionCode[] = [
  'jobs.read_assigned',
  'stages.start',
  'stages.complete',
];

/** Phase 4: what every floor role may additionally do on the stages assigned to them. */
const FLOOR_EXTRAS: readonly PermissionCode[] = [
  'stages.block',
  'production_notes.create',
];

export const GRANT_BATCHES: readonly GrantBatch[] = [
  {
    key: 'phase1-initial',
    grants: {
      ADMIN: [
        'users.read',
        'users.manage',
        'roles.read',
        'permissions.read',
        'customers.read',
        'customers.manage',
        'samples.read',
        'samples.manage',
        'jobs.read_all',
        'jobs.assign',
        'quotations.read',
        'quotations.create',
        'quotations.approve',
        'payments.read',
        'reports.read',
        'audit.read',
      ],
      SALES: [
        'customers.read',
        'customers.manage',
        'samples.read',
        'samples.manage',
        'quotations.read',
        'quotations.create',
        'jobs.read_all',
      ],
      FABRIC: STAGE_WORKER,
      PATTERN_MAKER: STAGE_WORKER,
      CUTTING: STAGE_WORKER,
      PRINTING: STAGE_WORKER,
      SEWING: STAGE_WORKER,
      QC: [...STAGE_WORKER, 'qc.perform'],
      PACKAGING: STAGE_WORKER,
      DELIVERY: STAGE_WORKER,
      FINANCE: [
        'payments.read',
        'payments.verify',
        'quotations.read',
        'customers.read',
        'reports.read',
      ],
    },
  },
  {
    key: 'phase2-master-data',
    grants: {
      ADMIN: [
        'master_data.read',
        'master_data.manage',
        'patterns.manage',
        'assets.read',
        'assets.manage',
      ],
      SALES: ['master_data.read', 'assets.read', 'assets.manage'],
      FABRIC: ['master_data.read', 'assets.read'],
      PATTERN_MAKER: [
        'master_data.read',
        'patterns.manage',
        'assets.read',
        'assets.manage',
      ],
      CUTTING: ['master_data.read', 'assets.read'],
      PRINTING: ['master_data.read', 'assets.read'],
      SEWING: ['master_data.read', 'assets.read'],
      QC: ['master_data.read', 'assets.read'],
      PACKAGING: ['master_data.read', 'assets.read'],
      FINANCE: ['master_data.read', 'assets.read'],
    },
  },
  {
    key: 'phase3-samples',
    grants: {
      ADMIN: [
        'samples.submit',
        'samples.review',
        'samples.assign',
        'samples.approve',
        'payments.manage',
        'approvals.manage',
        'terms.manage',
      ],
      SALES: [
        'samples.submit',
        'samples.review',
        'samples.approve',
        'approvals.manage',
        'payments.read',
        'payments.manage',
      ],
      FINANCE: ['samples.read', 'payments.manage'],
      PATTERN_MAKER: ['samples.read'],
    },
  },
  {
    key: 'phase4-factory',
    grants: {
      ADMIN: [
        'factory_jobs.manage',
        'production_board.read',
        'workflow_templates.read',
        'workflow_templates.manage',
        'stages.block',
        'stages.override',
        'qc.read',
        'qc.manage',
        'rework.manage',
        'production_notes.create',
      ],
      // Sales can see the board (summary) but never touches production stages.
      SALES: ['production_board.read'],
      FABRIC: FLOOR_EXTRAS,
      PATTERN_MAKER: FLOOR_EXTRAS,
      CUTTING: FLOOR_EXTRAS,
      PRINTING: FLOOR_EXTRAS,
      SEWING: FLOOR_EXTRAS,
      QC: [...FLOOR_EXTRAS, 'qc.read'],
      PACKAGING: FLOOR_EXTRAS,
      DELIVERY: FLOOR_EXTRAS,
    },
  },
  {
    key: 'phase5a-orders',
    grants: {
      ADMIN: [
        'orders.read',
        'orders.manage',
        'orders.confirm',
        'orders.cancel',
        'orders.reorder',
        'order_batches.read',
        'order_batches.manage',
        'production_quantity.report',
      ],
      // Sales owns the customer-facing order; production planning (batches, jobs) stays with ADMIN.
      SALES: [
        'orders.read',
        'orders.manage',
        'orders.confirm',
        'orders.reorder',
        'order_batches.read',
      ],
      FINANCE: ['orders.read'],
      // Floor roles report quantities, only on stages assigned to them (checked in the service).
      FABRIC: ['production_quantity.report'],
      PATTERN_MAKER: ['production_quantity.report'],
      CUTTING: ['production_quantity.report'],
      PRINTING: ['production_quantity.report'],
      SEWING: ['production_quantity.report'],
      QC: ['production_quantity.report'],
      PACKAGING: ['production_quantity.report'],
      DELIVERY: ['production_quantity.report'],
    },
  },
  {
    key: 'phase5b-fulfillment',
    grants: {
      ADMIN: [
        'packaging.manage',
        'shipments.read',
        'shipments.manage',
        'shipments.dispatch',
        'shipments.complete',
        'deliveries.read_assigned',
        'public_tracking.manage',
        'orders.commercial.read',
        'orders.commercial.manage',
        'orders.override',
      ],
      SALES: [
        'packaging.manage',
        'shipments.read',
        'public_tracking.manage',
        'orders.commercial.read',
        'orders.commercial.manage',
      ],
      FINANCE: ['orders.commercial.read'],
      // Delivery staff see and move only the deliveries assigned to them; no commercial data.
      DELIVERY: [
        'deliveries.read_assigned',
        'shipments.dispatch',
        'shipments.complete',
      ],
    },
  },
  {
    key: 'phase6a-management',
    grants: {
      ADMIN: [
        'dashboard.read',
        'management_kpis.read',
        'quality_kpis.read',
        'commercial_kpis.read',
        'workload.read',
        'capacity.read',
        'capacity.manage',
        'sla.read',
        'sla.manage',
        'eta.read',
      ],
      // order / production overview, no finance, no staff-level workload
      SALES: ['dashboard.read', 'management_kpis.read', 'sla.read', 'eta.read'],
      FINANCE: ['dashboard.read', 'commercial_kpis.read'],
      QC: ['quality_kpis.read'],
    },
  },
  {
    key: 'phase6b-automation',
    grants: {
      ADMIN: [
        'notifications.read_all',
        'notifications.manage',
        'notification_templates.read',
        'notification_templates.manage',
        'automation.read',
        'automation.manage',
        'qr_job_cards.read',
        'qr_job_cards.manage',
        'tech_packs.read',
        'tech_packs.generate',
        'tech_packs.issue',
        'working_calendar.read',
        'working_calendar.manage',
      ],
      // reading ANY tech pack is a management right; floor roles read the issued pack of the jobs they are
      // assigned to through GET /staff/jobs/:id/tech-pack (jobs.read_assigned + an active assignment)
      SALES: ['tech_packs.read', 'working_calendar.read'],
    },
  },
  {
    // phase5b-fulfillment gave SALES packaging.manage but omitted it for ADMIN, which is documented as "ADMIN all"
    key: 'admin-packaging-manage',
    grants: { ADMIN: ['packaging.manage'] },
  },
  {
    // ADMIN may execute any stage; stages.override (already ADMIN-only) lifts just the assignment gate
    key: 'admin-stage-execution',
    grants: {
      ADMIN: [
        'stages.start',
        'stages.complete',
        'qc.perform',
        'jobs.read_assigned',
      ],
    },
  },
  {
    // who owns which factory area by default, and the admin's view of a customer's operational process
    key: 'responsibilities',
    grants: {
      ADMIN: ['responsibilities.read', 'responsibilities.manage'],
      SALES: ['responsibilities.read'],
    },
  },
];

const META: Record<SystemRoleCode, { name: string; description: string }> = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    description: 'Full system control, including roles and settings',
  },
  ADMIN: {
    name: 'Admin',
    description: 'Day-to-day administration; cannot manage roles or settings',
  },
  SALES: {
    name: 'Sales',
    description: 'Customer relationships, samples and quotations',
  },
  FABRIC: {
    name: 'Fabric',
    description: 'Fabric sourcing and preparation stage',
  },
  PATTERN_MAKER: { name: 'Pattern Maker', description: 'Pattern-making stage' },
  CUTTING: { name: 'Cutting', description: 'Cutting stage' },
  PRINTING: { name: 'Printing', description: 'Printing and embroidery stage' },
  SEWING: { name: 'Sewing', description: 'Sewing stage' },
  QC: {
    name: 'Quality Control',
    description: 'Quality inspections at all gates',
  },
  PACKAGING: { name: 'Packaging', description: 'Packaging stage' },
  DELIVERY: { name: 'Delivery', description: 'Dispatch and delivery' },
  FINANCE: {
    name: 'Finance',
    description: 'Payment verification and financial reporting',
  },
};

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] =
  SYSTEM_ROLE_CODES.map((code) => ({
    code,
    ...META[code],
    permissions:
      code === 'SUPER_ADMIN'
        ? ALL_PERMISSION_CODES
        : [
            ...new Set(
              GRANT_BATCHES.flatMap((batch) => batch.grants[code] ?? []),
            ),
          ],
  }));
