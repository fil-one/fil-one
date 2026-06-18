import { z } from 'zod';
import { S3Region } from '../constants.js';

export type AccessKeyStatus = 'active' | 'inactive';

export const ACCESS_KEY_PERMISSIONS = [
  'GetObject',
  'ListMultipartUploadParts',
  'GetObjectVersion',
  'GetObjectRetention',
  'GetObjectLegalHold',
  'PutObject',
  'AbortMultipartUpload',
  'PutObjectRetention',
  'PutObjectLegalHold',
  'ListBucket',
  'ListBucketMultipartUploads',
  'ListBucketVersions',
  'DeleteObject',
  'DeleteObjectVersion',
] as const;
export type AccessKeyPermission = (typeof ACCESS_KEY_PERMISSIONS)[number];

export const DEFAULT_ACCESS_KEY_PERMISSIONS: AccessKeyPermission[] = [
  'GetObject',
  'ListMultipartUploadParts',
  'PutObject',
  'AbortMultipartUpload',
  'ListBucket',
  'ListBucketMultipartUploads',
];

export const ACCESS_KEY_PERMISSION_GROUP_ORDER = ['Read', 'Write', 'List', 'Delete'] as const;
export type AccessKeyPermissionGroup = (typeof ACCESS_KEY_PERMISSION_GROUP_ORDER)[number];

export const ACCESS_KEY_PERMISSION_LABELS: Record<
  AccessKeyPermission,
  { label: string; description: string; group: AccessKeyPermissionGroup }
> = {
  GetObject: {
    label: 'Get object',
    description: 'Download and retrieve objects',
    group: 'Read',
  },
  ListMultipartUploadParts: {
    label: 'List multipart upload parts',
    description: 'View the parts of in-progress multipart uploads',
    group: 'Read',
  },
  GetObjectVersion: {
    label: 'Read object versions',
    description: 'Retrieve specific versions of objects',
    group: 'Read',
  },
  GetObjectRetention: {
    label: 'Read retention settings',
    description: 'View retention policies on objects',
    group: 'Read',
  },
  GetObjectLegalHold: {
    label: 'Read legal hold status',
    description: 'View legal hold status on objects',
    group: 'Read',
  },
  PutObject: {
    label: 'Put object',
    description: 'Upload and overwrite objects',
    group: 'Write',
  },
  AbortMultipartUpload: {
    label: 'Abort multipart upload',
    description: 'Cancel in-progress multipart uploads',
    group: 'Write',
  },
  PutObjectRetention: {
    label: 'Set retention',
    description: 'Apply or modify retention policies',
    group: 'Write',
  },
  PutObjectLegalHold: {
    label: 'Set legal hold',
    description: 'Apply or remove legal holds on objects',
    group: 'Write',
  },
  ListBucket: {
    label: 'List bucket',
    description: 'Browse and list objects in the bucket',
    group: 'List',
  },
  ListBucketMultipartUploads: {
    label: 'List multipart uploads',
    description: 'View in-progress multipart uploads in the bucket',
    group: 'List',
  },
  ListBucketVersions: {
    label: 'List object versions',
    description: 'Browse version history of objects',
    group: 'List',
  },
  DeleteObject: {
    label: 'Delete object',
    description: 'Permanently remove objects',
    group: 'Delete',
  },
  DeleteObjectVersion: {
    label: 'Delete object versions',
    description: 'Remove specific object versions',
    group: 'Delete',
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
  });

export type CreateAccessKeyRequest = z.infer<typeof CreateAccessKeySchema>;

export interface AccessKey {
  id: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  lastUsedAt?: string;
  status: AccessKeyStatus;
  permissions: AccessKeyPermission[];
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
