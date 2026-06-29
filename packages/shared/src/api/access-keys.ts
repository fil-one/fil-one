import { z } from 'zod';
import { S3Region, supportsBucketManagement } from '../constants.js';

export type AccessKeyStatus = 'active' | 'inactive';

/** Object-level data operations. Each may act as a parent for data-protection granulars. */
export const OBJECT_PERMISSIONS = ['read', 'write', 'list', 'delete'] as const;
export type ObjectPermission = (typeof OBJECT_PERMISSIONS)[number];

/**
 * Configurable, region-gated bucket-management permissions. They are standalone
 * top-level permissions (no parent object permission) and live alongside the
 * object permissions in the `permissions` array. Note that "list all buckets" is
 * intentionally absent: it is always granted by every region and is therefore not
 * configurable.
 */
export const BUCKET_PERMISSIONS = ['CreateBucket', 'DeleteBucket'] as const;
export type BucketPermission = (typeof BUCKET_PERMISSIONS)[number];

/**
 * Bucket-configuration read permissions. Selectable in every region (including
 * the Aurora region), unlike {@link BUCKET_PERMISSIONS}: they only read
 * bucket-level settings and don't require the region's bucket-management API.
 */
export const BUCKET_INFO_PERMISSIONS = [
  'GetBucketVersioning',
  'GetBucketObjectLockConfiguration',
] as const;
export type BucketInfoPermission = (typeof BUCKET_INFO_PERMISSIONS)[number];

/** All permissions selectable on an access key: object operations plus bucket management. */
export const ACCESS_KEY_PERMISSIONS = [
  ...OBJECT_PERMISSIONS,
  ...BUCKET_PERMISSIONS,
  ...BUCKET_INFO_PERMISSIONS,
] as const;
export type AccessKeyPermission = (typeof ACCESS_KEY_PERMISSIONS)[number];

/** Type guard: is this permission a (region-gated) bucket-management permission? */
export function isBucketPermission(
  permission: AccessKeyPermission,
): permission is BucketPermission {
  return (BUCKET_PERMISSIONS as readonly string[]).includes(permission);
}

/** Type guard: is this permission a bucket-configuration read permission? */
export function isBucketInfoPermission(
  permission: AccessKeyPermission,
): permission is BucketInfoPermission {
  return (BUCKET_INFO_PERMISSIONS as readonly string[]).includes(permission);
}

/** Type guard: is this permission an object-level permission? */
export function isObjectPermission(
  permission: AccessKeyPermission,
): permission is ObjectPermission {
  return (OBJECT_PERMISSIONS as readonly string[]).includes(permission);
}

export const GRANULAR_PERMISSIONS = [
  'GetObjectVersion',
  'GetObjectRetention',
  'GetObjectLegalHold',
  'PutObjectRetention',
  'PutObjectLegalHold',
  'ListBucketVersions',
  'DeleteObjectVersion',
] as const;
export type GranularPermission = (typeof GRANULAR_PERMISSIONS)[number];

export const GRANULAR_PERMISSION_MAP: Record<ObjectPermission, GranularPermission[]> = {
  read: ['GetObjectVersion', 'GetObjectRetention', 'GetObjectLegalHold'],
  write: ['PutObjectRetention', 'PutObjectLegalHold'],
  list: ['ListBucketVersions'],
  delete: ['DeleteObjectVersion'],
};

export const GRANULAR_PERMISSION_LABELS: Record<
  GranularPermission,
  { label: string; description: string }
> = {
  GetObjectVersion: {
    label: 'Read object versions',
    description: 'Retrieve specific versions of objects',
  },
  GetObjectRetention: {
    label: 'Read retention settings',
    description: 'View retention policies on objects',
  },
  GetObjectLegalHold: {
    label: 'Read legal hold status',
    description: 'View legal hold status on objects',
  },
  PutObjectRetention: {
    label: 'Set retention',
    description: 'Apply or modify retention policies',
  },
  PutObjectLegalHold: {
    label: 'Set legal hold',
    description: 'Apply or remove legal holds on objects',
  },
  ListBucketVersions: {
    label: 'List object versions',
    description: 'Browse version history of objects',
  },
  DeleteObjectVersion: {
    label: 'Delete object versions',
    description: 'Remove specific object versions',
  },
};

export const BUCKET_PERMISSION_LABELS: Record<
  BucketPermission,
  { label: string; description: string }
> = {
  CreateBucket: {
    label: 'Create bucket',
    description: 'Create new buckets',
  },
  DeleteBucket: {
    label: 'Delete bucket',
    description: 'Delete buckets',
  },
};

export const BUCKET_INFO_PERMISSION_LABELS: Record<
  BucketInfoPermission,
  { label: string; description: string }
> = {
  GetBucketVersioning: {
    label: 'Read bucket versioning',
    description: 'View the versioning state of buckets',
  },
  GetBucketObjectLockConfiguration: {
    label: 'Read object lock configuration',
    description: 'View the object lock settings of buckets',
  },
};

export const ACCESS_KEY_BUCKET_SCOPES = ['all', 'specific'] as const;
export type AccessKeyBucketScope = (typeof ACCESS_KEY_BUCKET_SCOPES)[number];

export const KEY_NAME_MAX_LENGTH = 64;
export const KEY_NAME_PATTERN = /^[a-zA-Z0-9 _\-.]+$/;

export const CreateAccessKeySchema = z
  .object({
    keyName: z
      .string()
      .trim()
      .min(1, 'Key name is required')
      .max(KEY_NAME_MAX_LENGTH, `Key name must be at most ${KEY_NAME_MAX_LENGTH} characters`)
      .regex(
        KEY_NAME_PATTERN,
        'Key name can only contain letters, numbers, spaces, hyphens, underscores, and periods',
      ),
    permissions: z.array(z.enum(ACCESS_KEY_PERMISSIONS)),
    granularPermissions: z.array(z.enum(GRANULAR_PERMISSIONS)).optional(),
    bucketScope: z.enum(ACCESS_KEY_BUCKET_SCOPES).default('all'),
    buckets: z.array(z.string()).optional(),
    region: z.enum(S3Region),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiresAt must be in YYYY-MM-DD format')
      .nullable()
      .optional(),
  })
  .refine((data) => data.bucketScope !== 'specific' || (data.buckets && data.buckets.length > 0), {
    message: 'At least one bucket is required when scope is "specific"',
    path: ['buckets'],
  })
  .refine((data) => data.permissions.length > 0, {
    message: 'At least one permission is required',
    path: ['permissions'],
  })
  .refine(
    (data) => {
      // Each granular must belong to a selected object permission.
      const granular = data.granularPermissions ?? [];
      if (!granular.length) return true;
      const valid = data.permissions
        .filter(isObjectPermission)
        .flatMap((p) => GRANULAR_PERMISSION_MAP[p]);
      return granular.every((g) => valid.includes(g));
    },
    {
      message: 'Granular permissions must belong to the selected basic permissions',
      path: ['granularPermissions'],
    },
  )
  .refine(
    (data) => !data.permissions.some(isBucketPermission) || supportsBucketManagement(data.region),
    {
      message: 'Bucket management permissions are not supported in the selected region',
      path: ['permissions'],
    },
  );

export type CreateAccessKeyRequest = z.infer<typeof CreateAccessKeySchema>;

export interface AccessKey {
  id: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  lastUsedAt?: string;
  status: AccessKeyStatus;
  permissions: AccessKeyPermission[];
  granularPermissions?: GranularPermission[];
  bucketScope: AccessKeyBucketScope;
  buckets?: string[];
  region?: S3Region;
  expiresAt?: string | null;
}

export interface ListAccessKeysResponse {
  keys: AccessKey[];
}

export interface CreateAccessKeyResponse {
  id: string;
  keyName: string;
  accessKeyId: string;
  secretAccessKey: string;
  createdAt: string;
}

export interface DeleteAccessKeyRequest {
  keyId: string;
}
