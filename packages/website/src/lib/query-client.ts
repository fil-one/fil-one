import { QueryClient } from '@tanstack/react-query';
import { type S3Region } from '@filone/shared';

export const ME_STALE_TIME = 10 * 60_000;

const NO_RETRY_STATUSES = new Set([401, 403]);

export function defaultRetry(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status !== undefined && NO_RETRY_STATUSES.has(status)) return false;
  return failureCount < 1;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 5 * 60_000,
      retry: defaultRetry,
    },
  },
});

export const queryKeys = {
  me: ['me'] as const,
  meWithMfa: ['me', 'mfa'] as const,
  usage: ['usage'] as const,
  billing: ['billing'] as const,
  invoices: ['invoices'] as const,
  activityRecent: (limit: number) => ['activity', 'recent', limit] as const,
  activityTrends: (period: '7d' | '30d') => ['activity', 'trends', period] as const,
  buckets: ['buckets'] as const,
  bucket: (bucketName: string, region: S3Region) => ['bucket', bucketName, region] as const,
  objects: (bucketName: string, region: S3Region) => ['objects', bucketName, region] as const,
  objectMetadata: (bucketName: string, objectKey: string, versionId?: string) =>
    ['object-metadata', bucketName, objectKey, ...(versionId ? [versionId] : [])] as const,
  // ['access-keys'] is the prefix — invalidateQueries on this key also invalidates
  // all bucket-scoped access key queries (prefix match).
  accessKeys: ['access-keys'] as const,
  bucketAccessKeys: (bucketName: string) => ['access-keys', bucketName] as const,
  bucketAnalytics: (bucketName: string, region: S3Region) =>
    ['bucket-analytics', bucketName, region] as const,
  instatusSummary: ['instatus-summary'] as const,
  // RAG Pipeline (FIL-555). Distinct from `buckets` so the RAG surface can be
  // refetched/invalidated independently of the storage buckets list.
  ragBuckets: ['rag-buckets'] as const,
  // ['rag-bucket-enabled'] is the prefix — invalidateQueries on this key also
  // invalidates all per-bucket enablement queries (prefix match).
  ragBucketEnabled: ['rag-bucket-enabled'] as const,
  ragBucketEnabledFor: (bucketName: string, region: S3Region) =>
    ['rag-bucket-enabled', bucketName, region] as const,
  // RAG API keys (query-endpoint bearer tokens) — distinct from `accessKeys`.
  ragApiKeys: ['rag-api-keys'] as const,
};
