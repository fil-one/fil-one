import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ListObjectVersionsResponse,
  GetBucketResponse,
  ListAccessKeysResponse,
  BucketAnalyticsResponse,
} from '@filone/shared';
import { apiRequest } from './api.js';
import { useObjectActions } from './use-object-actions.js';
import { queryKeys } from './query-client.js';
import { batchPresign } from './use-presign.js';
import { parseListObjectVersionsResponse, executePresignedUrl } from './aurora-s3.js';

export function useBucketDetail(bucketName: string) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const setCurrentPrefix = useCallback(
    (newPrefix: string) => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
        search: newPrefix ? { prefix: newPrefix } : {},
        replace: true,
      });
    },
    [navigate, bucketName],
  );

  const { data: bucketData } = useQuery({
    queryKey: queryKeys.bucket(bucketName),
    queryFn: () => apiRequest<GetBucketResponse>(`/buckets/${encodeURIComponent(bucketName)}`),
  });

  const {
    data: objectsData,
    isPending: objectsLoading,
    isError: objectsIsError,
    error: objectsError,
  } = useQuery({
    queryKey: queryKeys.objects(bucketName),
    queryFn: async (): Promise<ListObjectVersionsResponse> => {
      const { items } = await batchPresign([{ op: 'listObjectVersions', bucket: bucketName }]);
      const response = await executePresignedUrl(items[0].url, items[0].method);
      return parseListObjectVersionsResponse(await response.text());
    },
  });

  const { data: analyticsData } = useQuery({
    queryKey: queryKeys.bucketAnalytics(bucketName),
    queryFn: () =>
      apiRequest<BucketAnalyticsResponse>(`/buckets/${encodeURIComponent(bucketName)}/analytics`),
  });

  const { data: accessKeysData, isPending: accessKeysLoading } = useQuery({
    queryKey: queryKeys.bucketAccessKeys(bucketName),
    queryFn: () =>
      apiRequest<ListAccessKeysResponse>(`/access-keys?bucket=${encodeURIComponent(bucketName)}`),
  });

  const invalidateObjectsCache = useCallback(
    (key: string, versionId?: string) => {
      if (versionId) {
        queryClient.setQueryData<ListObjectVersionsResponse>(queryKeys.objects(bucketName), (old) =>
          old
            ? {
                ...old,
                versions: old.versions.filter((v) => !(v.key === key && v.versionId === versionId)),
              }
            : old,
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketName) });
    },
    [queryClient, bucketName],
  );

  const objectActions = useObjectActions({ bucketName, onDeleted: invalidateObjectsCache });

  const invalidateAccessKeysCache = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
    void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
  }, [queryClient]);

  return {
    setCurrentPrefix,
    bucket: bucketData?.bucket ?? null,
    versions: objectsData?.versions ?? [],
    analyticsData,
    accessKeys: accessKeysData?.keys ?? [],
    objectsLoading,
    objectsIsError,
    objectsError,
    accessKeysLoading,
    objectActions,
    invalidateAccessKeysCache,
  };
}
