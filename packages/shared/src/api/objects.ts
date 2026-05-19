import { z } from 'zod';

export interface S3Object {
  key: string;
  sizeBytes: number;
  lastModified: string;
  etag?: string;
}

export interface S3ObjectVersion extends S3Object {
  versionId: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
}

export interface ListObjectVersionsResponse {
  versions: S3ObjectVersion[];
  nextKeyMarker?: string;
  nextVersionIdMarker?: string;
  isTruncated: boolean;
}

export interface ListObjectsRequest {
  bucketName: string;
  prefix?: string;
  delimiter?: string;
  nextToken?: string;
  maxKeys?: number;
}

export interface ListObjectsResponse {
  objects: S3Object[];
  prefix?: string;
  nextToken?: string;
  isTruncated: boolean;
}

export const PresignUploadSchema = z.object({
  key: z.string().trim().min(1, 'Object key is required').max(1024, 'Object key is too long'),
  contentType: z.string().trim().min(1, 'Content type is required'),
  fileName: z.string().trim().min(1, 'File name is required'),
  description: z.string().max(1000, 'Description must be at most 1000 characters').optional(),
  tags: z
    .array(z.string().trim().min(1, 'Tag must not be empty').max(128, 'Tag is too long'))
    .max(50, 'At most 50 tags allowed')
    .optional(),
});

export type PresignUploadRequest = z.infer<typeof PresignUploadSchema>;

export interface PresignUploadResponse {
  url: string;
  key: string;
}

export interface ObjectRetentionInfo {
  mode: 'GOVERNANCE' | 'COMPLIANCE';
  retainUntilDate: string;
}

export interface ObjectMetadataResponse {
  key: string;
  sizeBytes: number;
  lastModified: string;
  etag?: string;
  contentType?: string;
  metadata: Record<string, string>;
  retention?: ObjectRetentionInfo;
}

export const HeadObjectQuerySchema = z.object({
  key: z.string().min(1, 'Object key query parameter is required'),
});

export interface DeleteObjectRequest {
  bucketName: string;
  key: string;
}
