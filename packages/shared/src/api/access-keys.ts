import { z } from 'zod';

export type AccessKeyStatus = 'active' | 'inactive';

export const ACCESS_KEY_PERMISSIONS = ['read', 'write', 'list', 'delete'] as const;
export type AccessKeyPermission = (typeof ACCESS_KEY_PERMISSIONS)[number];

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
