import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Alert } from '../components/Alert';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ObjectAccessAside } from '../components/ObjectAccessAside';
import { ObjectDetailHeader, ObjectHeaderActions } from '../components/ObjectDetailHeader';
import { formatRetainUntil, ObjectDetailsCard } from '../components/ObjectDetailsCard';
import { ObjectPreviewCard } from '../components/ObjectPreview';
import { ShareObjectModal } from '../components/ShareObjectModal';
import { Skeleton } from '../components/Skeleton';
import { VersionHistoryCard } from '../components/VersionHistoryCard';

import type {
  ObjectMetadataResponse,
  ObjectRetentionInfo,
  GetBucketResponse,
  S3Region,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { getFolderPrefixes } from '../lib/object-preview.js';
import { getVersionState, useObjectVersions } from '../lib/object-versions.js';
import { useObjectActions } from '../lib/use-object-actions.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { useCanShareObjects } from '../lib/use-can-share-objects.js';
import { usePermittedDialog } from '../lib/use-permitted-dialog.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys, queryClient } from '../lib/query-client.js';
import { batchPresign } from '../lib/use-presign.js';
import {
  parseHeadObjectResponse,
  parseGetObjectRetentionResponse,
  executePresignedUrl,
} from '../lib/aurora-s3.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMetadataResponse(
  head: ReturnType<typeof parseHeadObjectResponse>,
  retention?: ObjectRetentionInfo,
): ObjectMetadataResponse {
  return {
    key: head.key,
    sizeBytes: head.sizeBytes,
    lastModified: head.lastModified,
    ...(head.etag && { etag: head.etag }),
    ...(head.contentType && { contentType: head.contentType }),
    metadata: head.metadata,
    ...(retention && { retention }),
  };
}

export type ObjectDetailPageProps = {
  bucketName: string;
  region: S3Region;
  objectKey: string;
  versionId?: string;
};

async function fetchObjectRetention(
  url: string,
  method: string,
): Promise<ObjectRetentionInfo | undefined> {
  try {
    const response = await executePresignedUrl(url, method);
    const xml = await response.text();
    return parseGetObjectRetentionResponse(xml) ?? undefined;
  } catch (err) {
    // Objects without retention configured return an S3 error — this is expected.
    const msg = err instanceof Error ? err.message : '';
    const isExpected =
      msg.includes('NoSuchObjectLockConfiguration') ||
      msg.includes('ObjectLockConfigurationNotFoundError');
    if (!isExpected) {
      console.error('Failed to fetch object retention:', err);
    }
    return undefined;
  }
}

/**
 * The bucket's settings, under the bucket page's own key and cache times, so
 * arriving from there costs nothing. Fetched here too because a shared link or a
 * reload lands on this page cold, and Object Lock decides whether the object can
 * hold a retention period at all.
 */
function bucketQueryOptions(bucketName: string, region: S3Region) {
  return {
    queryKey: queryKeys.bucket(bucketName, region),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () =>
      apiRequest<GetBucketResponse>(
        `/buckets/${encodeURIComponent(bucketName)}?${new URLSearchParams({ region }).toString()}`,
      ),
  };
}

async function isObjectLockEnabled(bucketName: string, region: S3Region): Promise<boolean> {
  try {
    const { bucket } = await queryClient.ensureQueryData(bucketQueryOptions(bucketName, region));
    return bucket.objectLockEnabled ?? false;
  } catch {
    // Without the bucket's settings the object's own details still load; only the
    // retention lookup is skipped
    return false;
  }
}

function useObjectMetadata({ bucketName, region, objectKey, versionId }: ObjectDetailPageProps) {
  return useQuery({
    queryKey: queryKeys.objectMetadata(bucketName, objectKey, versionId),
    queryFn: async (): Promise<ObjectMetadataResponse> => {
      const hasObjectLock = await isObjectLockEnabled(bucketName, region);

      const ops = [
        {
          op: 'headObject' as const,
          bucket: bucketName,
          key: objectKey,
          ...(versionId && { versionId }),
        },
        ...(hasObjectLock
          ? [
              {
                op: 'getObjectRetention' as const,
                bucket: bucketName,
                key: objectKey,
                ...(versionId && { versionId }),
              },
            ]
          : []),
      ];
      const { items } = await batchPresign(region, ops);

      const headResponse = await executePresignedUrl(items[0].url, items[0].method);
      const head = parseHeadObjectResponse(headResponse, objectKey);

      const retention =
        hasObjectLock && items[1]
          ? await fetchObjectRetention(items[1].url, items[1].method)
          : undefined;

      return buildMetadataResponse(head, retention);
    },
  });
}

/**
 * What Delete will do, which depends on what it targets. A version named in the
 * URL is removed for good and the rest stay. Without one, a versioned bucket
 * keeps every version and hides the object behind a delete marker, so calling
 * that permanent, as this dialog used to, was wrong.
 */
function getDeleteCopy(
  versionId: string | undefined,
  isVersioned: boolean,
): { title: string; description: string; confirmLabel: string } {
  if (versionId) {
    return {
      title: 'Delete version',
      description:
        'This version will be permanently deleted. Other versions of the object stay in its history.',
      confirmLabel: 'Delete version',
    };
  }
  if (isVersioned) {
    return {
      title: 'Delete object',
      description:
        'The object will be hidden behind a delete marker. Its earlier versions stay in its history.',
      confirmLabel: 'Delete object',
    };
  }
  return {
    title: 'Delete object',
    description: 'This object will be permanently deleted. This action cannot be undone.',
    confirmLabel: 'Delete object',
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * One object: what it looks like, what it is, and how to reach it from code.
 *
 * Laid out like the create bucket page: a 520px column of cards and, once both
 * fit beside the app sidebar, a quiet column beside it. The aside holds the API
 * access details, which are reference material rather than facts about the
 * object, so they sit apart from the details card instead of competing with it.
 */
export function ObjectDetailPage(props: ObjectDetailPageProps) {
  const { bucketName, region, objectKey, versionId } = props;
  const navigate = useNavigate();
  const { data: metadata, isPending, isError, error } = useObjectMetadata(props);
  const bucketQuery = useQuery(bucketQueryOptions(bucketName, region));
  const { data: versions = [] } = useObjectVersions(bucketName, region, objectKey);
  const versionState = getVersionState(versions, versionId);

  const mayDelete = useHasPermission('objects.delete');
  const canShare = useCanShareObjects();

  // The confirmation goes with the Delete control it was opened from.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = usePermittedDialog(false, mayDelete);
  const [shareOpen, setShareOpen] = useState(false);

  // Back to the folder the object sits in, which is where the user came from
  const parentPrefix = getFolderPrefixes(objectKey).at(-1)?.prefix;
  const returnToFolder = () =>
    void navigate({
      to: '/buckets/$bucketName',
      params: { bucketName },
      search: { region, ...(parentPrefix && { prefix: parentPrefix }) },
    });

  // Deleting one version of several leaves the object, so the page goes to what
  // is now its latest; anything else leaves nothing here to show
  const afterDelete = () => {
    void queryClient.invalidateQueries({ queryKey: ['objects', bucketName, region] });
    void queryClient.invalidateQueries({ queryKey: ['object-metadata', bucketName, objectKey] });
    if (versionId && versions.length > 1) {
      void navigate({
        to: '/buckets/$bucketName/objects',
        params: { bucketName },
        search: { key: objectKey, region },
      });
    } else {
      returnToFolder();
    }
  };

  const objectActions = useObjectActions({ bucketName, region, onDeleted: afterDelete });
  const download = () => void objectActions.downloadObject(objectKey, versionId);
  const deleteCopy = getDeleteCopy(versionId, versionState.isVersioned);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-6 px-5 pt-6 pb-12 sm:px-8 lg:px-10 lg:pt-10 xl:px-0">
      <ObjectDetailHeader
        bucketName={bucketName}
        region={region}
        objectKey={objectKey}
        versionState={versionState}
        onBack={returnToFolder}
        actions={
          <ObjectHeaderActions
            s3Uri={`s3://${bucketName}/${objectKey}`}
            isVersion={Boolean(versionId)}
            canShare={canShare}
            mayDelete={mayDelete}
            onDownload={download}
            onShare={() => setShareOpen(true)}
            onDelete={() => setConfirmDeleteOpen(true)}
          />
        }
      />

      {/* Two columns once both fit beside the app sidebar; stacked below that */}
      <div className="flex flex-col gap-6 xl:flex-row xl:gap-10">
        <div className="flex w-full max-w-[520px] shrink-0 flex-col gap-6">
          {isError ? (
            <Alert variant="red" description={error?.message ?? 'Failed to load object details'} />
          ) : isPending ? (
            <ObjectBodySkeleton />
          ) : (
            <>
              {metadata.retention?.mode === 'COMPLIANCE' && (
                <Alert
                  variant="red"
                  title="Compliance retention lock"
                  description={`This object is locked until ${formatRetainUntil(metadata.retention.retainUntilDate)}. It cannot be deleted before this date.`}
                />
              )}
              <ObjectPreviewCard
                bucketName={bucketName}
                region={region}
                objectKey={objectKey}
                versionId={versionId}
                sizeBytes={metadata.sizeBytes}
                contentType={metadata.contentType}
                onDownload={download}
              />
              <ObjectDetailsCard
                metadata={metadata}
                versionId={versionState.shownVersionId}
                objectLockEnabled={bucketQuery.data?.bucket.objectLockEnabled ?? false}
              />
              <VersionHistoryCard
                versions={versions}
                currentVersionId={versionState.shown?.versionId ?? versionId}
                bucketName={bucketName}
                region={region}
              />
            </>
          )}
        </div>

        <ObjectAccessAside bucketName={bucketName} region={region} objectKey={objectKey} />
      </div>

      <ShareObjectModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        bucketName={bucketName}
        region={region}
        objectKey={objectKey}
        versionId={versionId}
      />

      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={() => objectActions.deleteObject(objectKey, versionId)}
        {...deleteCopy}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Stands in for the preview and details cards while the object's metadata is in
 * flight, at roughly their height, so the cards do not push the page down when
 * they land. The header needs nothing from the request, so it renders at once.
 */
function ObjectBodySkeleton() {
  return (
    <div role="status" aria-label="Loading object details" className="flex flex-col gap-6">
      <Skeleton className="h-72 rounded-xl" />
      <Card>
        <Skeleton className="mb-4 h-5 w-16" />
        <div className="flex flex-col gap-3">
          {['size', 'type', 'modified', 'etag', 'retention', 'tags'].map((row) => (
            <Skeleton key={row} className="h-5 w-2/3" />
          ))}
        </div>
      </Card>
    </div>
  );
}
