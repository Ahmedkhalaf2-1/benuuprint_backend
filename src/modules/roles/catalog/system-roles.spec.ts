import { ALL_PERMISSION_CODES } from '../../../common/enums/permissions.js';
import { SYSTEM_ROLE_CODES } from '../../../common/enums/system-roles.js';
import { GRANT_BATCHES, SYSTEM_ROLES } from './system-roles.js';

describe('system role catalogue', () => {
  it('defines every system role exactly once', () => {
    expect(SYSTEM_ROLES.map((r) => r.code).sort()).toEqual(
      [...SYSTEM_ROLE_CODES].sort(),
    );
  });

  it('only references permissions that exist in the catalogue', () => {
    const known = new Set<string>(ALL_PERMISSION_CODES);
    for (const role of SYSTEM_ROLES) {
      for (const code of role.permissions) expect(known.has(code)).toBe(true);
    }
  });

  it('gives SUPER_ADMIN everything and keeps ADMIN strictly smaller', () => {
    const sa = SYSTEM_ROLES.find((r) => r.code === 'SUPER_ADMIN')!;
    const admin = SYSTEM_ROLES.find((r) => r.code === 'ADMIN')!;
    expect(sa.permissions).toHaveLength(ALL_PERMISSION_CODES.length);
    expect(admin.permissions.length).toBeLessThan(sa.permissions.length);
    expect(admin.permissions).not.toContain('roles.manage');
    expect(admin.permissions).not.toContain('settings.manage');
  });

  it('keeps grant batches well-formed: unique keys, known permissions and roles', () => {
    expect(new Set(GRANT_BATCHES.map((b) => b.key)).size).toBe(
      GRANT_BATCHES.length,
    );
    const known = new Set<string>(ALL_PERMISSION_CODES);
    const roles = new Set<string>(SYSTEM_ROLE_CODES);
    for (const batch of GRANT_BATCHES) {
      for (const [role, grants] of Object.entries(batch.grants)) {
        expect(roles.has(role)).toBe(true);
        expect(role).not.toBe('SUPER_ADMIN');
        for (const code of grants ?? []) expect(known.has(code)).toBe(true);
      }
    }
  });

  it('limits Phase 2 write access: only ADMIN manages master data, pattern makers manage patterns', () => {
    const grants = (code: string) =>
      SYSTEM_ROLES.find((r) => r.code === code)!.permissions;
    for (const role of SYSTEM_ROLES) {
      if (role.code === 'SUPER_ADMIN' || role.code === 'ADMIN') continue;
      expect(role.permissions).not.toContain('master_data.manage');
    }
    expect(grants('ADMIN')).toContain('master_data.manage');
    expect(grants('PATTERN_MAKER')).toContain('patterns.manage');
    expect(grants('SALES')).not.toContain('patterns.manage');
    expect(grants('SALES')).toContain('assets.manage');
    expect(grants('DELIVERY')).not.toContain('master_data.read');
    expect(grants('DELIVERY')).not.toContain('assets.read');
  });

  it('keeps commercial mutation rights away from production roles (Phase 3)', () => {
    const commercial = [
      'samples.manage',
      'samples.submit',
      'samples.review',
      'samples.assign',
      'samples.approve',
      'quotations.create',
      'quotations.approve',
      'payments.manage',
      'payments.verify',
      'approvals.manage',
      'terms.manage',
    ];
    for (const code of [
      'FABRIC',
      'PATTERN_MAKER',
      'CUTTING',
      'PRINTING',
      'SEWING',
      'QC',
      'PACKAGING',
      'DELIVERY',
    ]) {
      const granted = SYSTEM_ROLES.find((r) => r.code === code)!.permissions;
      expect(granted.filter((p) => commercial.includes(p))).toEqual([]);
    }
  });

  it('splits the commercial duties between sales, finance and admin (Phase 3)', () => {
    const grants = (code: string) =>
      SYSTEM_ROLES.find((r) => r.code === code)!.permissions;
    // sales works the sample and records customer decisions, but does not verify money
    expect(grants('SALES')).toEqual(
      expect.arrayContaining([
        'samples.submit',
        'samples.review',
        'samples.approve',
        'approvals.manage',
        'payments.manage',
      ]),
    );
    expect(grants('SALES')).not.toContain('payments.verify');
    expect(grants('SALES')).not.toContain('samples.assign');
    expect(grants('SALES')).not.toContain('terms.manage');
    // finance verifies and records payments, reads samples, cannot change them
    expect(grants('FINANCE')).toEqual(
      expect.arrayContaining([
        'payments.verify',
        'payments.manage',
        'samples.read',
      ]),
    );
    expect(grants('FINANCE')).not.toContain('samples.manage');
    expect(grants('FINANCE')).not.toContain('approvals.manage');
    // admin assigns and manages terms but cannot verify payments (separation of duties)
    expect(grants('ADMIN')).toEqual(
      expect.arrayContaining([
        'samples.assign',
        'terms.manage',
        'approvals.manage',
      ]),
    );
    expect(grants('ADMIN')).not.toContain('payments.verify');
    expect(grants('PATTERN_MAKER')).toContain('samples.read');
  });
});
