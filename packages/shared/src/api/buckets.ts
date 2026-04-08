import { z } from 'zod';

export const BUCKET_NAME_MIN_LENGTH = 3;
export const BUCKET_NAME_MAX_LENGTH = 63;
export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const RETENTION_MODES = ['governance', 'compliance'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export const RETENTION_DURATION_TYPES = ['d', 'y'] as const;
export type RetentionDurationType = (typeof RETENTION_DURATION_TYPES)[number];

export const RETENTION_MAX_DAYS = 36500;
export const RETENTION_MAX_YEARS = 100;

const RetentionSchema = z
  .object({
    enabled: z.literal(true),
    mode: z.enum(RETENTION_MODES),
    duration: z.number().int().min(1, 'Duration must be at least 1'),
    durationType: z.enum(RETENTION_DURATION_TYPES),
  })
  .refine(
    (data) =>
      data.duration <= (data.durationType === 'y' ? RETENTION_MAX_YEARS : RETENTION_MAX_DAYS),
    {
      message: `Duration exceeds the maximum allowed`,
      path: ['duration'],
    },
  );

export const CreateBucketSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(
        BUCKET_NAME_MIN_LENGTH,
        `Bucket name must be at least ${BUCKET_NAME_MIN_LENGTH} characters`,
      )
      .max(
        BUCKET_NAME_MAX_LENGTH,
        `Bucket name must be at most ${BUCKET_NAME_MAX_LENGTH} characters`,
      )
      .regex(
        BUCKET_NAME_PATTERN,
        'Lowercase letters, numbers, and hyphens only. Must start and end with a letter or number.',
      ),
    region: z.string().min(1, 'Region is required'),
    versioning: z.boolean().optional().default(false),
    lock: z.boolean().optional().default(false),
    retention: RetentionSchema.optional(),
  })
  .refine((data) => !data.lock || data.versioning, {
    message: 'Versioning must be enabled to use Object Lock',
    path: ['lock'],
  })
  .refine((data) => !data.retention?.enabled || data.lock, {
    message: 'Object Lock must be enabled to use Retention',
    path: ['retention'],
  });

export interface Bucket {
  name: string;
  region: string;
  createdAt: string;
  isPublic: boolean;
}

export interface ListBucketsResponse {
  buckets: Bucket[];
}

export interface CreateBucketRequest {
  name: string;
  region: string;
  versioning?: boolean;
  lock?: boolean;
  retention?: {
    enabled: true;
    mode: RetentionMode;
    duration: number;
    durationType: RetentionDurationType;
  };
}

export interface CreateBucketResponse {
  bucket: Bucket;
}

export interface GetBucketResponse {
  bucket: Bucket;
}

export interface DeleteBucketRequest {
  bucketName: string;
}
