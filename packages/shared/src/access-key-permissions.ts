import {
  ACCESS_KEY_PERMISSIONS,
  GRANULAR_PERMISSIONS,
  type AccessKeyPermission,
  type GranularPermission,
} from './api/access-keys.js';
import { permissionsForRole } from './permissions.js';
import type { Permission } from './permissions.js';

/**
 * What a member must already hold to put a permission on a new access key.
 *
 * A SigV4 key is authority that leaves the console: once minted, it acts over
 * S3 with whatever it carries, and no role check runs on that path until M3.
 * The cap is therefore the whole of what keeps the console matrix from being
 * cosmetic — without it a Member denied `buckets.delete` in the console mints
 * a key and does it over S3 instead.
 *
 * The two vocabularies do not line up one for one, and the mapping resolves
 * that conservatively: every bucket-level and data-protection permission maps
 * to `buckets.delete`, the most privileged bucket capability, because the
 * console's four permissions cannot express "may configure a bucket" or "may
 * set retention" and a key must never carry more than its creator. What that
 * means in practice is the ADR's line: a key a Member mints carries at most
 * read, list, write, and delete on objects. Finer grants are what M2's
 * privileged-operation flow is for.
 */
export const ACCESS_KEY_PERMISSION_REQUIREMENT: Record<AccessKeyPermission, Permission> = {
  read: 'objects.read',
  list: 'objects.read',
  write: 'objects.write',
  delete: 'objects.delete',
  CreateBucket: 'buckets.delete',
  DeleteBucket: 'buckets.delete',
  GetBucketVersioning: 'buckets.delete',
  GetBucketObjectLockConfiguration: 'buckets.delete',
};

/**
 * The same question for the data-protection granulars. Reading a retention
 * setting and writing one are both bucket-level authority here: they are
 * redeemed at the vendor, where their use cannot be audit-logged.
 */
export const GRANULAR_PERMISSION_REQUIREMENT: Record<GranularPermission, Permission> = {
  GetObjectVersion: 'buckets.delete',
  GetObjectRetention: 'buckets.delete',
  GetObjectLegalHold: 'buckets.delete',
  PutObjectRetention: 'buckets.delete',
  PutObjectLegalHold: 'buckets.delete',
  ListBucketVersions: 'buckets.delete',
  DeleteObjectVersion: 'buckets.delete',
};

/** One requested key permission and the console permission it needs. */
export interface ExcessKeyPermission {
  /** The requested key permission, named as the caller wrote it. */
  keyPermission: string;
  /**
   * What the caller would have to hold to grant it, or undefined when the
   * value is not a key permission at all — nothing grants that.
   */
  requires?: Permission;
}

/**
 * The requested key permissions the actor's role cannot grant, in request
 * order, so a denial can name them.
 *
 * A value in neither table is refused rather than ignored. The schema rejects
 * unknown permissions long before this runs, so one arriving here means the
 * schema and this mapping have diverged, and the safe reading of "we do not
 * know what this grants" is that nobody may grant it.
 */
export function excessKeyPermissions(
  actorRole: string,
  request: {
    permissions: readonly string[];
    granularPermissions?: readonly string[];
  },
): ExcessKeyPermission[] {
  const held = new Set<Permission>(permissionsForRole(actorRole));

  const requested: ExcessKeyPermission[] = [
    ...request.permissions.map((keyPermission) => ({
      keyPermission,
      requires: requirementFor(keyPermission, ACCESS_KEY_PERMISSION_REQUIREMENT, [
        ...ACCESS_KEY_PERMISSIONS,
      ]),
    })),
    ...(request.granularPermissions ?? []).map((keyPermission) => ({
      keyPermission,
      requires: requirementFor(keyPermission, GRANULAR_PERMISSION_REQUIREMENT, [
        ...GRANULAR_PERMISSIONS,
      ]),
    })),
  ];

  return requested.filter(({ requires }) => requires === undefined || !held.has(requires));
}

/** The console permission a key permission needs, if it is one we know. */
function requirementFor(
  keyPermission: string,
  table: Record<string, Permission>,
  known: readonly string[],
): Permission | undefined {
  return known.includes(keyPermission) ? table[keyPermission] : undefined;
}
