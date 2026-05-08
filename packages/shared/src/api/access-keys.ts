import { z } from 'zod';

export type AccessKeyStatus = 'active' | 'inactive';

export const ACCESS_KEY_PERMISSIONS = ['read', 'write', 'list', 'delete'] as const;
export type AccessKeyPermission = (typeof ACCESS_KEY_PERMISSIONS)[number];

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

export const GRANULAR_PERMISSION_MAP: Record<AccessKeyPermission, GranularPermission[]> = {
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
    permissions: z
      .array(z.enum(ACCESS_KEY_PERMISSIONS))
      .min(1, 'At least one permission is required'),
    granularPermissions: z.array(z.enum(GRANULAR_PERMISSIONS)).optional(),
    bucketScope: z.enum(ACCESS_KEY_BUCKET_SCOPES).default('all'),
    buckets: z.array(z.string()).optional(),
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
  .refine(
    (data) => {
      if (!data.granularPermissions?.length) return true;
      const valid = data.permissions.flatMap((p) => GRANULAR_PERMISSION_MAP[p]);
      return data.granularPermissions.every((g) => valid.includes(g));
    },
    {
      message: 'Granular permissions must belong to the selected basic permissions',
      path: ['granularPermissions'],
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
