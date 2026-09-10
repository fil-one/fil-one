import { describe, it, expect } from 'vitest';
import { OrgRole } from './api/org.ts';
import {
  ACCESS_KEY_PERMISSIONS,
  GRANULAR_PERMISSIONS,
  GRANULAR_PERMISSION_MAP,
} from './api/access-keys.ts';
import {
  ACCESS_KEY_PERMISSION_REQUIREMENT,
  GRANULAR_PERMISSION_REQUIREMENT,
  excessKeyPermissions,
  canRetainAccessKey,
} from './access-key-permissions.ts';

/** The two granulars a key may carry only with `privileged.grant`. */
const ELEVATED = ['PutObjectRetention', 'PutObjectLegalHold'];

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

  it('asks for the console permission that grants the same bucket capability', () => {
    // Creating a bucket is `buckets.create` in the console and must be the same
    // here: asking for `buckets.delete` would refuse a Member the thing they do
    // every day. Reading a bucket's configuration is a read.
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.CreateBucket).toBe('buckets.create');
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.DeleteBucket).toBe('buckets.delete');
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.GetBucketVersioning).toBe('buckets.read');
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT.GetBucketObjectLockConfiguration).toBe('buckets.read');
  });

  it('gives each granular its parent permission unless it is elevated', () => {
    // The property the table is built from: a granular narrows the object
    // permission it hangs off, so it needs what that permission needs. Written
    // as a property rather than a list so a granular added to
    // GRANULAR_PERMISSION_MAP is covered the day it lands.
    for (const [parent, granulars] of Object.entries(GRANULAR_PERMISSION_MAP)) {
      for (const granular of granulars) {
        if (ELEVATED.includes(granular)) continue;
        expect([granular, GRANULAR_PERMISSION_REQUIREMENT[granular]]).toStrictEqual([
          granular,
          ACCESS_KEY_PERMISSION_REQUIREMENT[
            parent as keyof typeof ACCESS_KEY_PERMISSION_REQUIREMENT
          ],
        ]);
      }
    }
  });

  it('puts writing retention and legal hold behind privileged.grant', () => {
    // The two mutating retention operations: redeemed at the vendor where their
    // use cannot be logged, and able to make an object undeletable for years.
    // Presign refuses their equivalents for the same reason.
    for (const granular of ELEVATED) {
      expect([granular, GRANULAR_PERMISSION_REQUIREMENT[granular as never]]).toStrictEqual([
        granular,
        'privileged.grant',
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

  it('lets a Member mint everything a Member can already do', () => {
    // The console's default new-key form: the four object permissions plus the
    // bucket capabilities a Member holds. Refusing any of these would 403 a
    // Member who changed nothing on the form.
    expect(
      excessKeyPermissions(OrgRole.Member, {
        permissions: [
          'read',
          'list',
          'write',
          'delete',
          'CreateBucket',
          'GetBucketVersioning',
          'GetBucketObjectLockConfiguration',
        ],
        granularPermissions: [
          'GetObjectVersion',
          'GetObjectRetention',
          'GetObjectLegalHold',
          'ListBucketVersions',
          'DeleteObjectVersion',
        ],
      }),
    ).toStrictEqual([]);
  });

  it('stops a Member at bucket deletion, which they do not hold', () => {
    expect(
      excessKeyPermissions(OrgRole.Member, { permissions: ['read', 'DeleteBucket'] }),
    ).toStrictEqual([{ keyPermission: 'DeleteBucket', requires: 'buckets.delete' }]);
  });

  it('stops everyone below Owner at writing retention and legal hold', () => {
    for (const role of [OrgRole.Admin, OrgRole.Member]) {
      expect(
        excessKeyPermissions(role, {
          permissions: ['write'],
          granularPermissions: ['PutObjectRetention', 'PutObjectLegalHold'],
        }),
      ).toStrictEqual([
        { keyPermission: 'PutObjectRetention', requires: 'privileged.grant' },
        { keyPermission: 'PutObjectLegalHold', requires: 'privileged.grant' },
      ]);
    }
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
        permissions: ['DeleteBucket', 'read', 'write'],
        granularPermissions: ['PutObjectLegalHold'],
      }).map((excess) => excess.keyPermission),
    ).toStrictEqual(['DeleteBucket', 'PutObjectLegalHold']);
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

describe('canRetainAccessKey', () => {
  // Every key a member could hold, described by what it carries, so one pass
  // over a role answers the whole transition at once.
  const KEYS = {
    plainReadWrite: { permissions: ['read', 'write', 'list'] },
    deletesBuckets: { permissions: ['read', 'DeleteBucket'] },
    createsBuckets: { permissions: ['read', 'CreateBucket'] },
    holdsRetention: {
      permissions: ['read', 'write'],
      granularPermissions: ['PutObjectRetention'],
    },
    holdsLegalHold: {
      permissions: ['read', 'write'],
      granularPermissions: ['PutObjectLegalHold'],
    },
    readsVersions: {
      permissions: ['read', 'list'],
      granularPermissions: ['GetObjectVersion', 'ListBucketVersions'],
    },
    recovered: {},
  };

  function survivors(role: string): string[] {
    return Object.entries(KEYS)
      .filter(([, key]) => canRetainAccessKey(role, key).retained)
      .map(([name]) => name);
  }

  it('keeps every key for an Owner', () => {
    expect(survivors(OrgRole.Owner)).toStrictEqual([
      'plainReadWrite',
      'deletesBuckets',
      'createsBuckets',
      'holdsRetention',
      'holdsLegalHold',
      'readsVersions',
    ]);
  });

  it('takes the two privileged granulars from an Admin', () => {
    expect(survivors(OrgRole.Admin)).toStrictEqual([
      'plainReadWrite',
      'deletesBuckets',
      'createsBuckets',
      'readsVersions',
    ]);
  });

  it('takes DeleteBucket and the privileged granulars from a Member', () => {
    expect(survivors(OrgRole.Member)).toStrictEqual([
      'plainReadWrite',
      'createsBuckets',
      'readsVersions',
    ]);
  });

  it('takes every key from ReadOnly, which can hold none', () => {
    expect(survivors(OrgRole.ReadOnly)).toStrictEqual([]);
  });

  it('takes every key from a role that is not one of the four', () => {
    expect(survivors('billing')).toStrictEqual([]);
  });

  it('names the permissions that put a key above the new role', () => {
    expect(canRetainAccessKey(OrgRole.Member, KEYS.deletesBuckets)).toStrictEqual({
      retained: false,
      reason: 'exceeds_role',
      excess: [{ keyPermission: 'DeleteBucket', requires: 'buckets.delete' }],
    });
  });

  it('blames the role, not the key, when the role can mint nothing', () => {
    expect(canRetainAccessKey(OrgRole.ReadOnly, KEYS.plainReadWrite)).toStrictEqual({
      retained: false,
      reason: 'role_cannot_mint',
    });
  });

  it('refuses a row that records no permission set', () => {
    // A row the console rebuilt after a vendor 409. Nothing places it inside
    // the new role, and its secret was never returned to anyone.
    expect(canRetainAccessKey(OrgRole.Owner, KEYS.recovered)).toStrictEqual({
      retained: false,
      reason: 'permissions_unrecorded',
    });
  });

  it('reads an empty permission list as a recorded set, and keeps it', () => {
    expect(canRetainAccessKey(OrgRole.Member, { permissions: [] })).toStrictEqual({
      retained: true,
    });
  });
});
