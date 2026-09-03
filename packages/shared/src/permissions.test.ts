import { describe, it, expect } from 'vitest';
import { OrgRole } from './api/org.js';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  canChangeRole,
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
  'audit.export': [OrgRole.Owner, OrgRole.Admin],
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

  it('is frozen, table and rows, so a consumer cannot edit the matrix it reads', () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    for (const role of ALL_ROLES) {
      expect(Object.isFrozen(ROLE_PERMISSIONS[role])).toBe(true);
    }
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

  // A membership row is a DynamoDB string attribute, so the lookup has to be
  // total: any value at all resolves to a permission set, and only the four
  // roles resolve to a non-empty one.
  it.each([
    ['a word that is not one of the four roles', 'billing'],
    ['a role name in the wrong case', 'Owner'],
    ['the empty string', ''],
    ['an inherited method name', 'constructor'],
    ['the prototype itself', '__proto__'],
    ['another inherited method name', 'toString'],
    ['hasOwnProperty', 'hasOwnProperty'],
  ])('grants nothing for %s', (_label, role) => {
    expect(permissionsForRole(role)).toStrictEqual([]);
    expect(roleHasPermission(role, 'members.read')).toBe(false);
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

  it.each([
    ['a word that is not one of the four roles', 'billing'],
    ['a role name in the wrong case', 'Owner'],
    ['an inherited method name', 'constructor'],
    ['the empty string', ''],
  ])('refuses an Owner a target carrying %s', (_label, target) => {
    // An unrecognized target must not fall through to the members.manage
    // branch: a stored 'Owner' would then be managed as if it were a Member.
    expect(canManageTargetRole(OrgRole.Owner, target)).toBe(false);
    expect(canManageTargetRole(OrgRole.Admin, target)).toBe(false);
  });

  it('refuses an actor whose own role is unrecognized', () => {
    expect(canManageTargetRole('billing', OrgRole.Member)).toBe(false);
  });
});

describe('canChangeRole', () => {
  it.each([
    [OrgRole.Owner, OrgRole.Member, OrgRole.Admin, true],
    [OrgRole.Owner, OrgRole.Admin, OrgRole.Owner, true],
    [OrgRole.Owner, OrgRole.Owner, OrgRole.Member, true],
    [OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly, true],
    [OrgRole.Admin, OrgRole.ReadOnly, OrgRole.Admin, true],
    [OrgRole.Member, OrgRole.ReadOnly, OrgRole.Member, false],
    [OrgRole.ReadOnly, OrgRole.ReadOnly, OrgRole.Member, false],
  ])('%s changing %s → %s is %s', (actor, from, to, expected) => {
    expect(canChangeRole(actor, from, to)).toBe(expected);
  });

  it('holds an Admin to the ceiling at both ends of the change', () => {
    // Promotion reaches the role being granted; demotion reaches the role being
    // taken away. An Admin clears neither where an Owner is involved.
    expect(canChangeRole(OrgRole.Admin, OrgRole.Member, OrgRole.Owner)).toBe(false);
    expect(canChangeRole(OrgRole.Admin, OrgRole.Owner, OrgRole.Member)).toBe(false);
    expect(canChangeRole(OrgRole.Owner, OrgRole.Member, OrgRole.Owner)).toBe(true);
  });

  it('refuses a change touching a role value outside the enum', () => {
    expect(canChangeRole(OrgRole.Owner, 'billing', OrgRole.Member)).toBe(false);
    expect(canChangeRole(OrgRole.Owner, OrgRole.Member, 'billing')).toBe(false);
  });
});
