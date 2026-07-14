import { z } from 'zod';
import { S3Region } from '../constants.js';
import { KEY_NAME_MAX_LENGTH, KEY_NAME_PATTERN } from './access-keys.js';

/**
 * RAG API keys: named bearer tokens that authorize ONLY the RAG query endpoint
 * (`POST /api/buckets/{name}/query`). They are distinct from S3 access keys —
 * a RAG key cannot read or write bucket contents, only ask questions of a
 * bucket's index. The plaintext token (`sk_rag_...`) is returned exactly once
 * at creation; the backend stores only its SHA-256 hash plus a short display
 * prefix.
 */

export const RAG_KEY_TOKEN_PREFIX = 'sk_rag_';

/** Characters of the token shown in list UIs, e.g. `sk_rag_AbC12` (prefix + 5). */
export const RAG_KEY_DISPLAY_PREFIX_LENGTH = 12;

export const RAG_KEY_MAX_BUCKETS = 50;

export const RAG_KEY_BUCKET_SCOPES = ['all', 'specific'] as const;
export type RagKeyBucketScope = (typeof RAG_KEY_BUCKET_SCOPES)[number];

/**
 * A bucket a key is scoped to. Bucket names are region-scoped (the same name
 * can exist in two regions under different tenants), so scope entries are
 * (region, name) pairs — never a bare name.
 */
export const RagKeyBucketRefSchema = z.object({
  region: z.enum(S3Region),
  name: z.string().trim().min(3).max(63),
});
export type RagKeyBucketRef = z.infer<typeof RagKeyBucketRefSchema>;

const bucketRefKey = (b: RagKeyBucketRef): string => `${b.region}:${b.name}`;

export const CreateRagApiKeySchema = z
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
    bucketScope: z.enum(RAG_KEY_BUCKET_SCOPES).default('all'),
    buckets: z
      .array(RagKeyBucketRefSchema)
      .max(RAG_KEY_MAX_BUCKETS, `A key can be scoped to at most ${RAG_KEY_MAX_BUCKETS} buckets`)
      .optional(),
  })
  .refine((data) => data.bucketScope !== 'specific' || (data.buckets && data.buckets.length > 0), {
    message: 'At least one bucket is required when scope is "specific"',
    path: ['buckets'],
  })
  .refine((data) => data.bucketScope !== 'all' || !data.buckets?.length, {
    message: 'Buckets must not be provided when scope is "all"',
    path: ['buckets'],
  })
  .refine(
    (data) => new Set((data.buckets ?? []).map(bucketRefKey)).size === (data.buckets ?? []).length,
    {
      message: 'Duplicate bucket in scope',
      path: ['buckets'],
    },
  );

export type CreateRagApiKeyRequest = z.infer<typeof CreateRagApiKeySchema>;

export interface RagApiKey {
  id: string;
  keyName: string;
  /** Display-only token prefix (e.g. `sk_rag_AbC12`) — never the full token. */
  keyPrefix: string;
  bucketScope: RagKeyBucketScope;
  /** Present iff `bucketScope === 'specific'`. */
  buckets?: RagKeyBucketRef[];
  createdAt: string;
  creatorEmail?: string;
  lastUsedAt?: string;
}

export interface ListRagApiKeysResponse {
  keys: RagApiKey[];
}

export interface CreateRagApiKeyResponse {
  id: string;
  keyName: string;
  keyPrefix: string;
  /** The plaintext bearer token — returned exactly once, never stored or shown again. */
  token: string;
  bucketScope: RagKeyBucketScope;
  buckets?: RagKeyBucketRef[];
  createdAt: string;
}
