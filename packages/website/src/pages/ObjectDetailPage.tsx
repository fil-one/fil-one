import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  DownloadSimpleIcon,
  LinkIcon,
  LockIcon,
  TagIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useQuery } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Breadcrumb } from '../components/Breadcrumb';
import { CodeBlock } from '../components/CodeBlock';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyableField } from '../components/CopyableField';
import { IconButton } from '../components/IconButton';
import { ShareObjectModal } from '../components/ShareObjectModal';
import { Spinner } from '../components/Spinner';
import { VersionHistoryCard } from '../components/VersionHistoryCard';
import { formatBytes, getS3Endpoint, S3_REGION } from '@filone/shared';

import type {
  ObjectMetadataResponse,
  ObjectRetentionInfo,
  GetBucketResponse,
  ListObjectVersionsResponse,
} from '@filone/shared';
import { FILONE_STAGE } from '../env';
import { useObjectActions } from '../lib/use-object-actions.js';
import { queryKeys, queryClient } from '../lib/query-client.js';
import { batchPresign } from '../lib/use-presign.js';
import {
  parseHeadObjectResponse,
  parseGetObjectRetentionResponse,
  executePresignedUrl,
} from '../lib/aurora-s3.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const retentionDateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type ObjectDetailPageProps = {
  bucketName: string;
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

// eslint-disable-next-line max-lines-per-function, complexity/complexity
export function ObjectDetailPage({ bucketName, objectKey, versionId }: ObjectDetailPageProps) {
  const navigate = useNavigate();

  const {
    data: metadata,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: queryKeys.objectMetadata(bucketName, objectKey, versionId),
    queryFn: async (): Promise<ObjectMetadataResponse> => {
      const cachedBucket = queryClient.getQueryData<GetBucketResponse>(
        queryKeys.bucket(bucketName),
      );
      const hasObjectLock = cachedBucket?.bucket.objectLockEnabled ?? false;

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
      const { items } = await batchPresign(ops);

      const headResponse = await executePresignedUrl(items[0].url, items[0].method);
      const head = parseHeadObjectResponse(headResponse, objectKey);

      const retention =
        hasObjectLock && items[1]
          ? await fetchObjectRetention(items[1].url, items[1].method)
          : undefined;

      return buildMetadataResponse(head, retention);
    },
  });

  // Pull version history from the bucket object listing cache (no extra fetch)
  const cachedVersions = queryClient.getQueryData<ListObjectVersionsResponse>(
    queryKeys.objects(bucketName),
  );
  const objectVersions = (cachedVersions?.versions ?? []).filter((v) => v.key === objectKey);

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const objectActions = useObjectActions({
    bucketName,
    onDeleted: () => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
      });
    },
  });

  if (isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading object details" size={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-10">
        <Breadcrumb
          items={[
            { label: 'Buckets', href: '/buckets' },
            { label: bucketName, href: `/buckets/${bucketName}` },
            { label: objectKey },
          ]}
        />
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error?.message ?? 'Failed to load object metadata'}
        </div>
      </div>
    );
  }

  // Parse tags from metadata
  let tags: string[] = [];
  if (metadata?.metadata.tags) {
    try {
      const parsed: unknown = JSON.parse(metadata.metadata.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      // ignore invalid JSON
    }
  }

  // Strip surrounding quotes from ETag (S3 returns it wrapped in double-quotes).
  const etag = metadata?.etag?.replace(/^"|"$/g, '');

  const s3Path = `s3://${bucketName}/${objectKey}`;

  const s3Endpoint = getS3Endpoint(S3_REGION, FILONE_STAGE);

  const apiExample = `# Retrieve via S3 API
aws s3 cp s3://${bucketName}/${objectKey} ./local-copy \\
  --endpoint-url ${s3Endpoint}`;

  return (
    <div className="mx-auto max-w-2xl px-10 pt-10">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: 'Buckets', href: '/buckets' },
          { label: bucketName, href: `/buckets/${bucketName}` },
          { label: objectKey },
        ]}
      />

      {/* Page header */}
      <div className="mt-2 mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void navigate({ to: '/buckets/$bucketName', params: { bucketName } })}
          className="flex size-8 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900"
          aria-label="Back to bucket"
        >
          <ArrowLeftIcon size={16} aria-hidden="true" />
        </button>
        <div className="flex-1">
          <Heading tag="h1">{objectKey}</Heading>
          <p className="text-[13px] text-zinc-500">{bucketName}</p>
        </div>

        <div className="flex items-center gap-1">
          <IconButton
            icon={DownloadSimpleIcon}
            aria-label="Download object"
            onClick={() => void objectActions.downloadObject(objectKey, versionId)}
          />
          <IconButton
            icon={LinkIcon}
            aria-label="Share object"
            onClick={() => setShareOpen(true)}
          />
          <IconButton
            icon={TrashIcon}
            aria-label="Delete object"
            onClick={() => setConfirmDeleteOpen(true)}
          />
        </div>
      </div>

      {/* Object details card */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <Heading tag="h2" size="sm" className="mb-3">
          Object details
        </Heading>
        <div className="flex flex-col gap-2">
          <DetailRow label="Name" value={objectKey} mono />
          {metadata && <DetailRow label="Size" value={formatBytes(metadata.sizeBytes)} mono />}
          <DetailRow label="Bucket" value={bucketName} mono />
          <CopyableDetailRow label="S3 Path" value={s3Path} />
          {versionId && <CopyableDetailRow label="Version ID" value={versionId} />}
          {etag && <CopyableDetailRow label="ETag" value={etag} />}
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-zinc-500">Retention</span>
            {metadata?.retention ? (
              <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-900">
                <LockIcon size={12} />
                {metadata.retention.mode === 'COMPLIANCE' ? 'Compliance' : 'Governance'}
                {' \u00b7 Expires '}
                {retentionDateFormat.format(new Date(metadata.retention.retainUntilDate))}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-400">
                <LockIcon size={12} />
                None
              </span>
            )}
          </div>
          {metadata?.metadata.description && (
            <div className="flex items-start justify-between pt-2">
              <span className="pt-0.5 text-[13px] text-zinc-500">Description</span>
              <span className="text-right text-[13px] text-zinc-900">
                {metadata.metadata.description}
              </span>
            </div>
          )}
          <div className="flex items-start justify-between pt-2">
            <span className="pt-0.5 text-[13px] text-zinc-500">Tags</span>
            {tags.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600"
                  >
                    <TagIcon size={12} />
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[13px] text-zinc-400">None</span>
            )}
          </div>
        </div>
      </div>

      {metadata?.retention && metadata.retention.mode === 'COMPLIANCE' && (
        <div className="mt-6 rounded-lg border border-red-300/50 p-4">
          <div className="flex items-start gap-3">
            <LockIcon size={16} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
            <p className="text-[13px] text-red-600">
              This object is protected by a compliance retention lock until{' '}
              <span className="font-bold">
                {retentionDateFormat.format(new Date(metadata.retention.retainUntilDate))}
              </span>
              . It cannot be deleted before this date.
            </p>
          </div>
        </div>
      )}

      {/* Version history */}
      <VersionHistoryCard
        versions={objectVersions}
        currentVersionId={versionId}
        bucketName={bucketName}
      />

      {/* API access example card */}
      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <Heading tag="h2" size="sm" className="mb-3">
          API access example
        </Heading>
        <CodeBlock code={apiExample} language="bash" />
      </div>

      {/* Share dialog */}
      <ShareObjectModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        bucketName={bucketName}
        objectKey={objectKey}
        versionId={versionId}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={() => objectActions.deleteObject(objectKey, versionId)}
        title="Delete object"
        description="This object will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete object"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail row helper
// ---------------------------------------------------------------------------

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[13px] text-zinc-500">{label}</span>
      <span className={`text-xs text-zinc-900 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function CopyableDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[13px] text-zinc-500">{label}</span>
      <CopyableField label="" value={value} />
    </div>
  );
}
