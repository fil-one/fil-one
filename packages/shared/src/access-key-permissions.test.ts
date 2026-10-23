import { describe, it, expect } from 'vitest';
import { OrgRole } from './api/org.ts';
import { S3Region } from './constants.ts';
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
import type { ServiceKeyGrant } from './access-key-permissions.ts';

/** The two granulars a key may carry only with `privileged.grant`. */
const ELEVATED = ['PutObjectRetention', 'PutObjectLegalHold'];

describe('the console permission behind each key permission', () => {
  // A key permission with no entry would fall through the cap silently, so the
  // tables are exhaustive by construction and these pin it.
  it('names one for every key permission the schema accepts', () => {
    expect(Object.keys(ACCESS_KEY_PERMISSION_REQUIREMENT).sort()).toStrictEqual(
      [...ACCESS_KEY_PERMISSIONS].sort(),
    );
  });

  it('names one for every granular permission the schema accepts', () => {
    expect(Object.keys(GRANULAR_PERMISSION_REQUIREMENT).sort()).toStrictEqual(
      [...GRANULAR_PERMISSIONS].sort(),
    );
  });

  // Creating a bucket is `buckets.create` in the console and must be the same
  // here: asking for `buckets.delete` would refuse a Member the thing they do
  // every day. Reading a bucket's configuration is a read.
  it.each([
    ['read', 'objects.read'],
    ['list', 'objects.read'],
    ['write', 'objects.write'],
    ['delete', 'objects.delete'],
    ['CreateBucket', 'buckets.create'],
    ['DeleteBucket', 'buckets.delete'],
    ['GetBucketVersioning', 'buckets.read'],
    ['GetBucketObjectLockConfiguration', 'buckets.read'],
    ['PutBucketCORS', 'buckets.policy_manage'],
  ] as const)('maps %s to %s', (keyPermission, consolePermission) => {
    expect(ACCESS_KEY_PERMISSION_REQUIREMENT[keyPermission]).toBe(consolePermission);
  });

  // A granular narrows the object permission it hangs off, so it needs what
  // that permission needs. Derived from GRANULAR_PERMISSION_MAP so a granular
  // added there is covered the day it lands.
  it.each(
    Object.entries(GRANULAR_PERMISSION_MAP).flatMap(([parent, granulars]) =>
      granulars.filter((granular) => !ELEVATED.includes(granular)).map((g) => [g, parent]),
    ),
  )('gives the granular %s the requirement of its parent %s', (granular, parent) => {
    expect(GRANULAR_PERMISSION_REQUIREMENT[granular as never]).toBe(
      ACCESS_KEY_PERMISSION_REQUIREMENT[parent as never],
    );
  });

  // Redeemed at the vendor where their use cannot be logged, and able to make
  // an object undeletable for years. Presign refuses their equivalents too.
  it.each(ELEVATED)('puts %s behind privileged.grant', (granular) => {
    expect(GRANULAR_PERMISSION_REQUIREMENT[granular as never]).toBe('privileged.grant');
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

  it.each([OrgRole.Admin, OrgRole.Member])(
    'stops %s at writing retention and legal hold',
    (role) => {
      expect(
        excessKeyPermissions(role, {
          permissions: ['write'],
          granularPermissions: ['PutObjectRetention', 'PutObjectLegalHold'],
        }),
      ).toStrictEqual([
        { keyPermission: 'PutObjectRetention', requires: 'privileged.grant' },
        { keyPermission: 'PutObjectLegalHold', requires: 'privileged.grant' },
      ]);
    },
  );

  it('lets ReadOnly grant reading', () => {
    expect(excessKeyPermissions(OrgRole.ReadOnly, { permissions: ['read', 'list'] })).toStrictEqual(
      [],
    );
  });

  it('stops ReadOnly at writing and deleting', () => {
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
      }),
    ).toStrictEqual([
      { keyPermission: 'DeleteBucket', requires: 'buckets.delete' },
      { keyPermission: 'PutObjectLegalHold', requires: 'privileged.grant' },
    ]);
  });

  it('refuses a value that is not a key permission at all', () => {
    // The schema rejects these long before the cap runs. One arriving here
    // means the schema and this mapping have diverged, and nobody grants what
    // we cannot describe, not even an Owner.
    expect(excessKeyPermissions(OrgRole.Owner, { permissions: ['*'] })).toStrictEqual([
      { keyPermission: '*', requires: undefined },
    ]);
  });

  it('refuses everything for a role that is not one of the four', () => {
    expect(excessKeyPermissions('billing', { permissions: ['read'] })).toStrictEqual([
      { keyPermission: 'read', requires: 'objects.read' },
    ]);
  });
});

describe('canRetainAccessKey', () => {
  // Service keys described by what they carry, so one pass over a role answers
  // the whole transition at once.
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
    // A recovered row (see ServiceAccessKey.permissions) records no permissions.
    recovered: {},
  } satisfies Record<string, ServiceKeyGrant>;

  function retentionFor(role: string) {
    return Object.fromEntries(
      Object.entries(KEYS).map(([name, key]) => [name, canRetainAccessKey(role, key)]),
    );
  }

  const KEPT = { retained: true };
  const UNRECORDED = { retained: false, reason: 'permissions_unrecorded' };
  const CANNOT_MINT = { retained: false, reason: 'role_cannot_mint' };
  const exceeds = (keyPermission: string, requires: string) => ({
    retained: false,
    reason: 'exceeds_role',
    excess: [{ keyPermission, requires }],
  });

  it('keeps every key with recorded permissions for an Owner', () => {
    expect(retentionFor(OrgRole.Owner)).toStrictEqual({
      plainReadWrite: KEPT,
      deletesBuckets: KEPT,
      createsBuckets: KEPT,
      holdsRetention: KEPT,
      holdsLegalHold: KEPT,
      readsVersions: KEPT,
      recovered: UNRECORDED,
    });
  });

  it('takes the two privileged granulars from an Admin', () => {
    expect(retentionFor(OrgRole.Admin)).toStrictEqual({
      plainReadWrite: KEPT,
      deletesBuckets: KEPT,
      createsBuckets: KEPT,
      holdsRetention: exceeds('PutObjectRetention', 'privileged.grant'),
      holdsLegalHold: exceeds('PutObjectLegalHold', 'privileged.grant'),
      readsVersions: KEPT,
      recovered: UNRECORDED,
    });
  });

  it('takes DeleteBucket and the privileged granulars from a Member', () => {
    expect(retentionFor(OrgRole.Member)).toStrictEqual({
      plainReadWrite: KEPT,
      deletesBuckets: exceeds('DeleteBucket', 'buckets.delete'),
      createsBuckets: KEPT,
      holdsRetention: exceeds('PutObjectRetention', 'privileged.grant'),
      holdsLegalHold: exceeds('PutObjectLegalHold', 'privileged.grant'),
      readsVersions: KEPT,
      recovered: UNRECORDED,
    });
  });

  it.each([OrgRole.ReadOnly, 'billing'])(
    'takes every key from %s, which cannot mint any',
    (role) => {
      expect(retentionFor(role)).toStrictEqual({
        plainReadWrite: CANNOT_MINT,
        deletesBuckets: CANNOT_MINT,
        createsBuckets: CANNOT_MINT,
        holdsRetention: CANNOT_MINT,
        holdsLegalHold: CANNOT_MINT,
        readsVersions: CANNOT_MINT,
        recovered: CANNOT_MINT,
      });
    },
  );

  it('reads an empty permission list as a recorded set, and keeps it', () => {
    expect(canRetainAccessKey(OrgRole.Member, { permissions: [] })).toStrictEqual(KEPT);
  });

  // Bucket policies never see a service key, so on an `iam` region only a role
  // holding `keys.create_service` keeps one.
  const iamServiceKey: ServiceKeyGrant = {
    permissions: ['read', 'write'],
    region: S3Region.UsEast9,
  };

  it('takes a service key on an iam region from a Member, who lacks keys.create_service', () => {
    expect(canRetainAccessKey(OrgRole.Member, iamServiceKey)).toStrictEqual(CANNOT_MINT);
  });

  it('keeps a service key on an iam region for an Admin', () => {
    expect(canRetainAccessKey(OrgRole.Admin, iamServiceKey)).toStrictEqual(KEPT);
  });

  it('keeps a key on a service-keys region for a Member', () => {
    expect(
      canRetainAccessKey(OrgRole.Member, { ...iamServiceKey, region: S3Region.EuWest1 }),
    ).toStrictEqual(KEPT);
  });
});
