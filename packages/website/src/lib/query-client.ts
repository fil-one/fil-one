import { QueryClient } from '@tanstack/react-query';

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
  usage: ['usage'] as const,
  billing: ['billing'] as const,
  invoices: ['invoices'] as const,
  activityRecent: (limit: number) => ['activity', 'recent', limit] as const,
  activityTrends: (period: '7d' | '30d') => ['activity', 'trends', period] as const,
  buckets: ['buckets'] as const,
  bucket: (bucketName: string) => ['bucket', bucketName] as const,
  objects: (bucketName: string) => ['objects', bucketName] as const,
  objectMetadata: (bucketName: string, objectKey: string) =>
    ['object-metadata', bucketName, objectKey] as const,
  // ['access-keys'] is the prefix — invalidateQueries on this key also invalidates
  // all bucket-scoped access key queries (prefix match).
  accessKeys: ['access-keys'] as const,
  bucketAccessKeys: (bucketName: string) => ['access-keys', bucketName] as const,
};
