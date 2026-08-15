import { describe, it, expect } from 'vitest';
import { OrgRole } from './api/org.js';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  canManageTargetRole,
  permissionsForRole,
  roleHasPermission,
} from './permissions.js';
import type { Permission } from './permissions.js';

/**
 * The capability matrix, transcribed from the ADR as a table rather than as
 * assertions against the implementation — the point of the test is that the
 * shipped registry equals the product decision, so it has to be written twice.
 */
const MATRIX: Record<Permission, OrgRole[]> = {
  'members.read': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly],
  'members.manage': [OrgRole.Owner, OrgRole.Admin],
  'owners.manage': [OrgRole.Owner],
  'org.rename': [OrgRole.Owner, OrgRole.Admin],
  'org.transfer': [OrgRole.Owner],
  'org.delete': [OrgRole.Owner],
  'billing.manage': [OrgRole.Owner],
  'billing.view': [OrgRole.Owner, OrgRole.Admin],
  'buckets.read': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly],
  'buckets.create': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member],
  'buckets.delete': [OrgRole.Owner, OrgRole.Admin],
  'objects.read': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly],
  'objects.write': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member],
  'objects.delete': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member],
  'keys.create': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member],
  'keys.manage_own': [OrgRole.Owner, OrgRole.Admin, OrgRole.Member],
  'keys.manage_all': [OrgRole.Owner, OrgRole.Admin],
  'audit.view': [OrgRole.Owner, OrgRole.Admin],
  'privileged.grant': [OrgRole.Owner],
};

const ALL_ROLES = [OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly];

describe('PERMISSIONS', () => {
  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('covers exactly the permissions in the capability matrix', () => {
    expect([...PERMISSIONS].sort()).toStrictEqual(Object.keys(MATRIX).sort());
  });
});

describe('ROLE_PERMISSIONS', () => {
  it('defines a set for every role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toStrictEqual([...ALL_ROLES].sort());
  });

  it.each(ALL_ROLES)('grants %s exactly the matrix row', (role) => {
    const expected = Object.entries(MATRIX)
      .filter(([, roles]) => roles.includes(role))
      .map(([permission]) => permission)
      .sort();
    expect([...permissionsForRole(role)].sort()).toStrictEqual(expected);
  });

  it.each(ALL_ROLES)('lists %s permissions without duplicates', (role) => {
    const granted = permissionsForRole(role);
    expect(new Set(granted).size).toBe(granted.length);
  });

  it('grants every declared permission to at least one role', () => {
    const granted = new Set(ALL_ROLES.flatMap((role) => [...permissionsForRole(role)]));
    expect([...granted].sort()).toStrictEqual([...PERMISSIONS].sort());
  });

  it('reserves privileged, ownership, and payment control to the Owner', () => {
    const ownerOnly = PERMISSIONS.filter(
      (permission) =>
        roleHasPermission(OrgRole.Owner, permission) &&
        !roleHasPermission(OrgRole.Admin, permission),
    );
    expect([...ownerOnly].sort()).toStrictEqual([
      'billing.manage',
      'org.delete',
      'org.transfer',
      'owners.manage',
      'privileged.grant',
    ]);
  });

  it('nests the roles: each holds everything the role below it holds', () => {
    const byDescendingRank = [...ALL_ROLES].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
    expect(byDescendingRank).toStrictEqual([
      OrgRole.Owner,
      OrgRole.Admin,
      OrgRole.Member,
      OrgRole.ReadOnly,
    ]);
    for (let i = 0; i < byDescendingRank.length - 1; i++) {
      const higher = new Set(permissionsForRole(byDescendingRank[i]));
      for (const permission of permissionsForRole(byDescendingRank[i + 1])) {
        expect(higher.has(permission)).toBe(true);
      }
    }
  });
});

describe('roleHasPermission', () => {
  it('grants an Admin bucket deletion but not ownership transfer', () => {
    expect(roleHasPermission(OrgRole.Admin, 'buckets.delete')).toBe(true);
    expect(roleHasPermission(OrgRole.Admin, 'org.transfer')).toBe(false);
  });

  it('denies a ReadOnly member every write and every key', () => {
    expect(roleHasPermission(OrgRole.ReadOnly, 'objects.write')).toBe(false);
    expect(roleHasPermission(OrgRole.ReadOnly, 'objects.delete')).toBe(false);
    expect(roleHasPermission(OrgRole.ReadOnly, 'buckets.create')).toBe(false);
    expect(roleHasPermission(OrgRole.ReadOnly, 'keys.create')).toBe(false);
  });

  it('grants nothing for a role value outside the enum', () => {
    const unknown = 'billing' as OrgRole;
    expect(permissionsForRole(unknown)).toStrictEqual([]);
    expect(roleHasPermission(unknown, 'members.read')).toBe(false);
  });
});

describe('canManageTargetRole', () => {
  it.each([
    [OrgRole.Owner, OrgRole.Owner, true],
    [OrgRole.Owner, OrgRole.Admin, true],
    [OrgRole.Owner, OrgRole.Member, true],
    [OrgRole.Owner, OrgRole.ReadOnly, true],
    [OrgRole.Admin, OrgRole.Owner, false],
    [OrgRole.Admin, OrgRole.Admin, true],
    [OrgRole.Admin, OrgRole.Member, true],
    [OrgRole.Admin, OrgRole.ReadOnly, true],
    [OrgRole.Member, OrgRole.ReadOnly, false],
    [OrgRole.Member, OrgRole.Member, false],
    [OrgRole.ReadOnly, OrgRole.ReadOnly, false],
  ])('%s managing %s → %s', (actor, target, expected) => {
    expect(canManageTargetRole(actor, target)).toBe(expected);
  });

  it('stops an Admin from removing an Owner, not just from demoting one', () => {
    // Removal and demotion are the same ceiling: otherwise deleting an Owner
    // reaches what demoting one forbids.
    expect(canManageTargetRole(OrgRole.Admin, OrgRole.Owner)).toBe(false);
    expect(roleHasPermission(OrgRole.Admin, 'owners.manage')).toBe(false);
  });
});
