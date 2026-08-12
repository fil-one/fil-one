import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PlusIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { BucketProperties } from '../components/BucketPropertiesCard';
import { ObjectBrowser, countObjects } from '../components/ObjectBrowser';
import { BucketAccessTab } from '../components/BucketAccessTab';
import type { S3ObjectVersion, S3Region } from '@filone/shared';
import { getS3Endpoint } from '@filone/shared';
import { FILONE_STAGE } from '../env';

import type {
  Bucket,
  ListObjectVersionsResponse,
  GetBucketResponse,
  ListAccessKeysResponse,
  BucketAnalyticsResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { useObjectActions } from '../lib/use-object-actions.js';
import { queryKeys } from '../lib/query-client.js';
import { batchPresign } from '../lib/use-presign.js';
import {
  parseListObjectVersionsResponse,
  parseListObjectsResponse,
  executePresignedUrl,
} from '../lib/aurora-s3.js';

// Analytics has the full-bucket count; the listing is a single page (max 1000
// entries) so counting it undercounts large buckets. Fall back to the listing
// count only while analytics is loading (or if it fails).
function displayObjectCount(
  analytics: BucketAnalyticsResponse | undefined,
  versions: S3ObjectVersion[],
): number {
  return analytics?.objectCount ?? countObjects(versions);
}

// Fetch the object listing via presigned URL. Versioned buckets use
// ListObjectVersions so version history is available inline; non-versioned
// buckets use ListObjectsV2, which only ever returns live objects (never delete
// markers). Both paths are normalized to the ListObjectVersionsResponse shape so
// the cache and invalidation logic stay identical.
async function fetchObjectListing(
  region: S3Region,
  bucketName: string,
  bucket: Bucket | null,
): Promise<ListObjectVersionsResponse> {
  if (bucket?.versioning) {
    const { items } = await batchPresign(region, [
      { op: 'listObjectVersions', bucket: bucketName },
    ]);
    const response = await executePresignedUrl(items[0].url, items[0].method);
    return parseListObjectVersionsResponse(await response.text());
  }

  const { items } = await batchPresign(region, [{ op: 'listObjects', bucket: bucketName }]);
  const response = await executePresignedUrl(items[0].url, items[0].method);
  const { objects, isTruncated } = parseListObjectsResponse(await response.text());
  return {
    versions: objects.map((obj) => ({
      ...obj,
      versionId: '',
      isLatest: true,
      isDeleteMarker: false,
    })),
    isTruncated,
  };
}

function removeVersionFromListing(
  old: ListObjectVersionsResponse | undefined,
  key: string,
  versionId: string,
): ListObjectVersionsResponse | undefined {
  if (!old) return old;
  return {
    ...old,
    versions: old.versions.filter((v) => !(v.key === key && v.versionId === versionId)),
  };
}

function BucketErrorState({
  bucketName,
  error,
  fallback,
}: {
  bucketName: string;
  error: Error | null;
  fallback: string;
}) {
  return (
    <div className="px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
      <div className="mt-4">
        <Alert variant="red" description={error?.message ?? fallback} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type BucketDetailPageProps = {
  bucketName: string;
  prefix?: string;
  region: S3Region;
};

export function BucketDetailPage({ bucketName, prefix, region }: BucketDetailPageProps) {
  const s3Endpoint = getS3Endpoint(region, FILONE_STAGE);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentPrefix = prefix ?? '';

  const setCurrentPrefix = useCallback(
    (newPrefix: string) => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
        search: { region, ...(newPrefix ? { prefix: newPrefix } : {}) },
        replace: true,
      });
    },
    [navigate, bucketName, region],
  );

  // Bucket metadata
  const {
    data: bucketData,
    isError: bucketIsError,
    error: bucketError,
  } = useQuery({
    queryKey: queryKeys.bucket(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<GetBucketResponse>(
        `/buckets/${encodeURIComponent(bucketName)}?${params.toString()}`,
      );
    },
  });
  const bucket = bucketData?.bucket ?? null;

  // Objects. Gated on the bucket metadata so the versioning state is known
  // before choosing the listing op.
  const {
    data: objectsData,
    isPending: objectsLoading,
    isError: objectsIsError,
    error: objectsError,
  } = useQuery({
    queryKey: queryKeys.objects(bucketName, region),
    enabled: bucketData !== undefined,
    queryFn: () => fetchObjectListing(region, bucketName, bucket),
  });
  const versions = objectsData?.versions ?? [];

  // Bucket analytics (object count + storage)
  const { data: analyticsData } = useQuery({
    queryKey: queryKeys.bucketAnalytics(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<BucketAnalyticsResponse>(
        `/buckets/${encodeURIComponent(bucketName)}/analytics?${params.toString()}`,
      );
    },
  });

  // Access keys scoped to this bucket. Access keys are region-scoped, so the
  // region is part of the filter: a key from another region — even one scoped to
  // all buckets — cannot operate on this bucket.
  const { data: accessKeysData, isPending: accessKeysLoading } = useQuery({
    queryKey: queryKeys.bucketAccessKeys(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ bucket: bucketName, region });
      return apiRequest<ListAccessKeysResponse>(`/access-keys?${params.toString()}`);
    },
  });
  const accessKeys = accessKeysData?.keys ?? [];

  const [addKeyOpen, setAddKeyOpen] = useState(false);

  const invalidateObjectsCache = useCallback(
    (key: string, versionId?: string) => {
      if (versionId) {
        queryClient.setQueryData<ListObjectVersionsResponse>(
          queryKeys.objects(bucketName, region),
          (old) => removeVersionFromListing(old, key, versionId),
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketName, region) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bucketAnalytics(bucketName, region),
      });
    },
    [queryClient, bucketName, region],
  );

  const objectActions = useObjectActions({
    bucketName,
    region,
    onDeleted: invalidateObjectsCache,
  });

  const invalidateAccessKeysCache = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
    void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
  }, [queryClient]);

  // The objects query is gated on bucket metadata, so a metadata failure must be
  // surfaced here — otherwise the disabled objects query stays pending forever.
  if (bucketIsError) {
    return (
      <BucketErrorState
        bucketName={bucketName}
        error={bucketError}
        fallback="Failed to load bucket"
      />
    );
  }

  if (objectsLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading objects" size={32} />
      </div>
    );
  }

  if (objectsIsError) {
    return (
      <BucketErrorState
        bucketName={bucketName}
        error={objectsError}
        fallback="Failed to load objects"
      />
    );
  }

  return (
    <div className="px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />

      <div className="mt-4 flex items-center justify-between">
        <Heading tag="h1" size="xl">
          {bucketName}
        </Heading>
        <Button
          id="upload-object-button"
          variant="primary"
          size="sm"
          icon={PlusIcon}
          iconPosition="right"
          onClick={() =>
            void navigate({
              to: '/buckets/$bucketName/upload',
              params: { bucketName },
              search: { region },
            })
          }
        >
          Upload object
        </Button>
      </div>

      {/* Region, storage and creation date used to sit in a bullet-separated line
          here and again in the cards below, in two different visual languages.
          They're all properties of the bucket, so they live in one place now.
          BucketProperties owns its own spacing, since the expander changes how
          much room it needs. */}
      {bucket && <BucketProperties bucket={bucket} analytics={analyticsData} />}

      <Tabs>
        <TabList>
          <Tab testId="bucket-objects-tab">
            Objects ({displayObjectCount(analyticsData, versions).toLocaleString()})
          </Tab>
          <Tab testId="bucket-keys-tab">
            API Keys{!accessKeysLoading && ` (${accessKeys.length.toLocaleString()})`}
          </Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <ObjectBrowser
              bucketName={bucketName}
              region={region}
              versions={versions}
              versioningEnabled={bucket?.versioning ?? false}
              currentPrefix={currentPrefix}
              onPrefixChange={setCurrentPrefix}
              onDownload={objectActions.downloadObject}
              downloading={objectActions.downloading}
              onDelete={objectActions.deleteObject}
            />
          </TabPanel>

          <TabPanel>
            <BucketAccessTab
              bucketName={bucketName}
              s3Endpoint={s3Endpoint}
              region={region}
              accessKeys={accessKeys}
              accessKeysLoading={accessKeysLoading}
              onCreateOpen={() => setAddKeyOpen(true)}
            />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <AddBucketKeyModal
        open={addKeyOpen}
        onClose={() => setAddKeyOpen(false)}
        bucketName={bucketName}
        region={region}
        onKeyAdded={invalidateAccessKeysCache}
      />
    </div>
  );
}
