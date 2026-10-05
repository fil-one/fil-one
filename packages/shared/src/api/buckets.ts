import { z } from 'zod';
import { S3Region } from '../constants.ts';

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
    bucketName: z
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
  bucketName: string;
  region: string;
  createdAt: string;
  isPublic: boolean;
  objectLockEnabled?: boolean;
  versioning?: boolean;
  encrypted?: boolean;
  defaultRetention?: RetentionMode;
  retentionDuration?: number;
  retentionDurationType?: RetentionDurationType;
}

export interface ListBucketsResponse {
  buckets: Bucket[];
  /**
   * Regions whose listing failed, in registry order. `buckets` holds only what the healthy
   * regions returned. Omitted (never `[]`) when every region answers, so a healthy response is
   * byte-identical to what clients received before. Regions only: the orchestrator error stays
   * in the logs, where it cannot leak S3 or tenant internals to the browser.
   */
  unavailableRegions?: S3Region[];
}

/**
 * The single sentence naming the regions that could not be listed. Shared because the backend
 * puts it in the all-regions-down 503 body and the console puts it in the partial-result
 * banner; two copies of this string would drift.
 */
export function listBucketsUnavailableMessage(regions: readonly S3Region[]): string {
  const names =
    regions.length > 1
      ? `${regions.slice(0, -1).join(', ')} and ${regions[regions.length - 1]}`
      : regions[0];
  return `Cannot list buckets in the ${names} region${
    regions.length > 1 ? 's' : ''
  }. Please try again later.`;
}

export const BUCKET_SORT_KEYS = ['bucketName', 'region', 'createdAt'] as const;
export type BucketSortKey = (typeof BUCKET_SORT_KEYS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * `/buckets` query params. Filtering and sorting happen on the backend
 * (FIL-324): the frontend forwards these rather than filtering a full list
 * client-side, and a `region` match lets the handler skip calling orchestrators
 * outside that region entirely.
 */
export interface ListBucketsQuery {
  /** Case-insensitive substring match against bucketName. */
  search?: string;
  region?: string;
  sortKey?: BucketSortKey;
  sortDirection?: SortDirection;
}

export interface CreateBucketRequest {
  bucketName: string;
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

export interface BucketAnalyticsResponse {
  objectCount: number;
  bytesUsed: number;
}
