import { describe, it, expect } from 'vitest';
import { OrgRole } from './api/org.js';
import {
  ACCESS_KEY_PERMISSIONS,
  GRANULAR_PERMISSIONS,
  OBJECT_PERMISSIONS,
} from './api/access-keys.js';
import {
  ACCESS_KEY_PERMISSION_REQUIREMENT,
  GRANULAR_PERMISSION_REQUIREMENT,
  excessKeyPermissions,
} from './access-key-permissions.js';

describe('the console permission behind each key permission', () => {
  it('names one for every key permission the schema accepts', () => {
    // A key permission with no entry would fall through the cap silently, so
    // the tables are exhaustive by construction and this pins it.
    expect(Object.keys(ACCESS_KEY_PERMISSION_REQUIREMENT).sort()).toStrictEqual(
      [...ACCESS_KEY_PERMISSIONS].sort(),
    );
    expect(Object.keys(GRANULAR_PERMISSION_REQUIREMENT).sort()).toStrictEqual(
      [...GRANULAR_PERMISSIONS].sort(),
    );
  });

  it('maps the object permissions to their object counterparts', () => {
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.read).toBe('objects.read');
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.list).toBe('objects.read');
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.write).toBe('objects.write');
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.delete).toBe('objects.delete');
  });

  it('maps everything else to buckets.delete', () => {
    // Conservative on purpose: the console's four permissions cannot express
    // "may configure a bucket" or "may set retention", and a key must never
    // carry more than its creator.
    const beyondObjects = ACCESS_KEY_PERMISSIONS.filter(
      (permission) => !(OBJECT_PERMISSIONS as readonly string[]).includes(permission),
    );
    for (const permission of beyondObjects) {
      expect([permission, ACCESS_KEY_PERMISSION_REQUIREMENT[permission]]).toStrictEqual([
        permission,
        'buckets.delete',
      ]);
    }
    for (const permission of GRANULAR_PERMISSIONS) {
      expect([permission, GRANULAR_PERMISSION_REQUIREMENT[permission]]).toStrictEqual([
        permission,
        'buckets.delete',
      ]);
    }
  });
});

describe('excessKeyPermissions', () => {
  it('lets an Owner grant everything the schema accepts', () => {
    expect(
      excessKeyPermissions(OrgRole.Owner, {
        permissions: [...ACCESS_KEY_PERMISSIONS],
        granularPermissions: [...GRANULAR_PERMISSIONS],
      }),
    ).toStrictEqual([]);
  });

  it('caps a Member at the four object permissions', () => {
    expect(
      excessKeyPermissions(OrgRole.Member, { permissions: ['read', 'list', 'write', 'delete'] }),
    ).toStrictEqual([]);

    expect(
      excessKeyPermissions(OrgRole.Member, { permissions: ['read', 'DeleteBucket'] }),
    ).toStrictEqual([{ keyPermission: 'DeleteBucket', requires: 'buckets.delete' }]);
  });

  it('caps ReadOnly at reading', () => {
    expect(excessKeyPermissions(OrgRole.ReadOnly, { permissions: ['read', 'list'] })).toStrictEqual(
      [],
    );

    expect(
      excessKeyPermissions(OrgRole.ReadOnly, { permissions: ['write', 'delete'] }),
    ).toStrictEqual([
      { keyPermission: 'write', requires: 'objects.write' },
      { keyPermission: 'delete', requires: 'objects.delete' },
    ]);
  });

  it('reports the excess in request order, so a denial can name it', () => {
    expect(
      excessKeyPermissions(OrgRole.Member, {
        permissions: ['CreateBucket', 'read', 'DeleteBucket'],
      }).map((excess) => excess.keyPermission),
    ).toStrictEqual(['CreateBucket', 'DeleteBucket']);
  });

  it('refuses a value that is not a key permission at all', () => {
    // The schema rejects these long before the cap runs. One arriving here
    // means the schema and this mapping have diverged, and nobody grants what
    // we cannot describe — not even an Owner.
    expect(excessKeyPermissions(OrgRole.Owner, { permissions: ['*'] })).toStrictEqual([
      { keyPermission: '*', requires: undefined },
    ]);
  });

  it('refuses everything for a role that is not one of the four', () => {
    expect(
      excessKeyPermissions('billing', { permissions: ['read'] }).map(
        (excess) => excess.keyPermission,
      ),
    ).toStrictEqual(['read']);
  });
});
