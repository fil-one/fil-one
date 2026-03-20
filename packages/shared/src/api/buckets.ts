import { z } from 'zod';

export const BUCKET_NAME_MIN_LENGTH = 3;
export const BUCKET_NAME_MAX_LENGTH = 63;
export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const CreateBucketSchema = z.object({
  name: z
    .string()
    .trim()
    .min(
      BUCKET_NAME_MIN_LENGTH,
      `Bucket name must be at least ${BUCKET_NAME_MIN_LENGTH} characters`,
    )
    .max(BUCKET_NAME_MAX_LENGTH, `Bucket name must be at most ${BUCKET_NAME_MAX_LENGTH} characters`)
    .regex(
      BUCKET_NAME_PATTERN,
      'Lowercase letters, numbers, and hyphens only. Must start and end with a letter or number.',
    ),
  region: z.string().min(1, 'Region is required'),
});

export interface Bucket {
  name: string;
  region: string;
  createdAt: string;
  objectCount: number;
  sizeBytes: number;
  isPublic: boolean;
}

export interface ListBucketsResponse {
  buckets: Bucket[];
}

export interface CreateBucketRequest {
  name: string;
  region: string;
}

export interface CreateBucketResponse {
  bucket: Bucket;
}

export interface DeleteBucketRequest {
  bucketName: string;
}
