export const SYSTEM_ROLE_CODES = [
  'SUPER_ADMIN',
  'ADMIN',
  'SALES',
  'FABRIC',
  'PATTERN_MAKER',
  'CUTTING',
  'PRINTING',
  'SEWING',
  'QC',
  'PACKAGING',
  'DELIVERY',
  'FINANCE',
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

/** Protected role: the system must always keep at least one active holder. */
export const SUPER_ADMIN_ROLE_CODE: SystemRoleCode = 'SUPER_ADMIN';
