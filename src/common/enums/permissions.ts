/**
 * Permission catalogue: the contract between code and data.
 * Code declares which permission a route needs; the seed upserts these rows
 * and roles are granted permissions as data. Never branch on role names.
 */
export const PERMISSION_CATALOG = {
  'users.read': 'View staff users',
  'users.manage':
    'Create, update, suspend and archive staff users and assign their roles',
  'roles.read': 'View roles and their permissions',
  'roles.manage':
    'Create, update and delete roles and change their permissions',
  'permissions.read': 'View the permission catalogue',
  'customers.read': 'View customers and brands',
  'customers.manage': 'Create, update and archive customers and brands',
  'samples.read': 'View samples',
  'samples.manage':
    'Create and update samples and move them through the lifecycle',
  'jobs.read_assigned': 'View factory jobs and stages assigned to the user',
  'jobs.read_all': 'View all factory jobs',
  'jobs.assign': 'Assign and reassign production stages to staff',
  'stages.start': 'Start an assigned production stage',
  'stages.complete': 'Complete an assigned production stage',
  'qc.perform': 'Record quality-control results',
  'quotations.read': 'View quotations',
  'quotations.create': 'Draft and submit quotations',
  'quotations.approve': 'Approve quotations internally',
  'payments.read': 'View payments',
  'payments.verify': 'Verify or reject payment proofs',
  'reports.read': 'View reports and dashboards',
  'settings.manage': 'Change system settings and configuration catalogues',
  'audit.read': 'View the audit log',
  'master_data.read':
    'View master data (product types, fabrics, print methods, accessories, sizes, patterns)',
  'master_data.manage': 'Create, update and archive master data',
  'patterns.manage': 'Create pattern versions and approve patterns',
  'assets.read': 'View file metadata and obtain private download links',
  'assets.manage': 'Upload, attach, update and archive files',
  'samples.submit': 'Submit a draft sample for review',
  'samples.review':
    'Review samples: start review, request changes, hold/resume and reject',
  'samples.assign': 'Assign a sales owner to a sample',
  'samples.approve':
    'Record customer approval of a produced sample or its production specification',
  'payments.manage': 'Record, edit and cancel sample payments',
  'approvals.manage':
    'Request approvals and record customer decisions (quotation, artwork, sample)',
  'terms.manage': 'Publish and activate versions of the sample terms',
  'factory_jobs.manage':
    'Create factory jobs from approved samples; release, prioritise, hold, resume and cancel jobs',
  'production_board.read': 'View the production board',
  'workflow_templates.read':
    'View workflow templates and production stage definitions',
  'workflow_templates.manage':
    'Create and activate workflow template versions and stage definitions',
  'stages.block': 'Raise and resolve blockers on production stages',
  'stages.override':
    'Override stage or job progression (reason required, audited)',
  'qc.read': 'View QC inspections and QC templates',
  'qc.manage': 'Publish QC templates and override QC outcomes',
  'rework.manage': 'Create and manage rework manually',
  'production_notes.create':
    'Add production notes and evidence photos to jobs and stages',
  'orders.read': 'View bulk orders and their production summary',
  'orders.manage':
    'Create and edit draft orders, revise confirmed orders, set priority, mark ready',
  'orders.confirm':
    'Confirm a bulk order and freeze its production specification',
  'orders.cancel': 'Cancel bulk orders (reason required)',
  'orders.reorder': 'Create a reorder from an existing order',
  'order_batches.read': 'View production batches of an order',
  'order_batches.manage':
    'Create, allocate, hold and cancel production batches',
  'production_quantity.report':
    'Report produced, rejected and rework quantities on assigned stages',
  'packaging.manage': 'Define and edit the packaging specification of an order',
  'shipments.read': 'View shipments and their delivery proof',
  'shipments.manage':
    'Create, edit, assign, ready and cancel shipments (address snapshot, partial shipments)',
  'shipments.dispatch': 'Dispatch shipments and mark them in transit',
  'shipments.complete':
    'Confirm delivery, record failed deliveries and returns, attach delivery proof',
  'deliveries.read_assigned': 'View the deliveries assigned to the user',
  'public_tracking.manage':
    'Generate, regenerate and revoke the customer tracking link of an order',
  'orders.commercial.read':
    'View the quotation, payments and payment state of an order',
  'orders.commercial.manage':
    'Record the customer decision on an order quotation',
  'orders.override':
    'Force-complete an order that did not follow the normal delivery path (reason required)',
  'dashboard.read':
    'View the management dashboard, Needs Attention list and pipelines',
  'management_kpis.read':
    'View production, order and delivery KPIs and bottleneck analysis',
  'quality_kpis.read': 'View quality KPIs (QC, rework, rejected units)',
  'commercial_kpis.read':
    'View commercial KPIs (accepted value, verified payments, balances)',
  'workload.read':
    'View department, staff and work-in-progress workload and team performance',
  'capacity.read': 'View configured capacity and capacity utilization',
  'capacity.manage': 'Configure department and staff capacity',
  'sla.read': 'View SLA rules and SLA / delay evaluation of jobs and orders',
  'sla.manage': 'Create, change and deactivate SLA rules',
  'eta.read': 'View estimated completion times of jobs and orders',
  'notifications.read_all':
    'Inspect operational notification delivery, outbox and scheduler health',
  'notifications.manage':
    'Retry or cancel notifications and manage staff / customer notification preferences',
  'notification_templates.read': 'View notification templates',
  'notification_templates.manage':
    'Publish and activate notification template versions',
  'automation.read':
    'View automation rules, escalation rules and operational alerts',
  'automation.manage': 'Change automation and escalation rules',
  'qr_job_cards.read': 'View job cards and the QR token status of a job',
  'qr_job_cards.manage': 'Generate, rotate and revoke job QR tokens',
  'tech_packs.read':
    'Read issued tech packs (floor staff: for assigned work only)',
  'tech_packs.generate':
    'Generate tech pack versions from frozen production specifications',
  'tech_packs.issue': 'Issue and supersede tech packs',
  'working_calendar.read': 'View the factory working calendar',
  'responsibilities.read':
    'View default responsibility rules, customer overrides and the operational process of customers',
  'responsibilities.manage':
    'Configure default responsibilities and customer overrides, and apply them to active work',
  'working_calendar.manage':
    'Change the working calendar, holidays and exceptional days',
} as const;

export type PermissionCode = keyof typeof PERMISSION_CATALOG;

export const ALL_PERMISSION_CODES = Object.keys(
  PERMISSION_CATALOG,
) as PermissionCode[];
