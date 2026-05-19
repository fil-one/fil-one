import { z } from 'zod';

export const PresignListObjectsOpSchema = z.object({
  op: z.literal('listObjects'),
  bucket: z.string().min(1, 'Bucket name is required'),
  prefix: z.string().optional(),
  delimiter: z.string().optional(),
  maxKeys: z.number().int().positive().optional(),
  continuationToken: z.string().optional(),
});

export const PresignListObjectVersionsOpSchema = z.object({
  op: z.literal('listObjectVersions'),
  bucket: z.string().min(1, 'Bucket name is required'),
  prefix: z.string().optional(),
  delimiter: z.string().optional(),
  maxKeys: z.number().int().positive().optional(),
  keyMarker: z.string().optional(),
  versionIdMarker: z.string().optional(),
});

export const PresignHeadObjectOpSchema = z.object({
  op: z.literal('headObject'),
  bucket: z.string().min(1, 'Bucket name is required'),
  key: z.string().min(1, 'Object key is required'),
  versionId: z.string().optional(),
});

export const PresignGetObjectRetentionOpSchema = z.object({
  op: z.literal('getObjectRetention'),
  bucket: z.string().min(1, 'Bucket name is required'),
  key: z.string().min(1, 'Object key is required'),
  versionId: z.string().optional(),
});

export const PresignGetObjectOpSchema = z.object({
  op: z.literal('getObject'),
  bucket: z.string().min(1, 'Bucket name is required'),
  key: z.string().min(1, 'Object key is required'),
  versionId: z.string().optional(),
  expiresIn: z
    .number()
    .int()
    .positive()
    .max(604800, 'Expiry must be at most 7 days (604800 seconds)')
    .optional(),
});

export const PresignPutObjectOpSchema = z.object({
  op: z.literal('putObject'),
  bucket: z.string().min(1, 'Bucket name is required'),
  key: z.string().trim().min(1, 'Object key is required').max(1024, 'Object key is too long'),
  contentType: z.string().trim().min(1, 'Content type is required'),
  fileName: z.string().trim().min(1, 'File name is required'),
  description: z.string().max(1000, 'Description must be at most 1000 characters').optional(),
  tags: z
    .array(z.string().trim().min(1, 'Tag must not be empty').max(128, 'Tag is too long'))
    .max(50, 'At most 50 tags allowed')
    .optional(),
});

export const PresignDeleteObjectOpSchema = z.object({
  op: z.literal('deleteObject'),
  bucket: z.string().min(1, 'Bucket name is required'),
  key: z.string().min(1, 'Object key is required'),
  versionId: z.string().optional(),
});

export const PresignOpSchema = z.discriminatedUnion('op', [
  PresignListObjectsOpSchema,
  PresignListObjectVersionsOpSchema,
  PresignHeadObjectOpSchema,
  PresignGetObjectRetentionOpSchema,
  PresignGetObjectOpSchema,
  PresignPutObjectOpSchema,
  PresignDeleteObjectOpSchema,
]);

export const PresignRequestSchema = z
  .array(PresignOpSchema)
  .min(1, 'At least one operation is required')
  .max(10, 'At most 10 operations per request');

export type PresignOp = z.infer<typeof PresignOpSchema>;
export type PresignRequest = z.infer<typeof PresignRequestSchema>;

export type PresignHttpMethod = 'GET' | 'HEAD' | 'PUT' | 'DELETE';

export interface PresignResponseItem {
  url: string;
  method: PresignHttpMethod;
  expiresAt: string;
}

export interface PresignResponse {
  items: PresignResponseItem[];
  endpoint: string;
}
