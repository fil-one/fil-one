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

import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
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
  S3Region,
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

// eslint-disable-next-line max-lines-per-function, complexity/complexity
export function ObjectDetailPage({
  bucketName,
  region,
  objectKey,
  versionId,
}: ObjectDetailPageProps) {
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
        queryKeys.bucket(bucketName, region),
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

  // Pull version history from the bucket object listing cache (no extra fetch)
  const cachedVersions = queryClient.getQueryData<ListObjectVersionsResponse>(
    queryKeys.objects(bucketName),
  );
  const objectVersions = (cachedVersions?.versions ?? []).filter((v) => v.key === objectKey);

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const objectActions = useObjectActions({
    bucketName,
    region,
    onDeleted: () => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
        search: { region },
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
        <Alert variant="red" description={error?.message ?? 'Failed to load object metadata'} />
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
      <div className="mt-6 mb-6 flex items-center gap-3">
        <IconButton
          icon={ArrowLeftIcon}
          aria-label="Back to bucket"
          onClick={() =>
            void navigate({
              to: '/buckets/$bucketName',
              params: { bucketName },
              search: { region },
            })
          }
        />
        <div className="min-w-0 flex-1">
          <Heading tag="h1" className="truncate">
            {objectKey}
          </Heading>
          <p className="text-sm text-(--color-paragraph-text-subtle)">{bucketName}</p>
        </div>

        <div className="flex items-center gap-1">
          <IconButton
            icon={DownloadSimpleIcon}
            aria-label="Download object"
            tooltip="Download"
            tooltipSide="bottom"
            onClick={() => void objectActions.downloadObject(objectKey, versionId)}
          />
          <IconButton
            icon={LinkIcon}
            aria-label="Share object"
            tooltip="Share object"
            tooltipSide="bottom"
            onClick={() => setShareOpen(true)}
          />
          <IconButton
            icon={TrashIcon}
            aria-label="Delete object"
            tooltip="Delete"
            tooltipSide="bottom"
            onClick={() => setConfirmDeleteOpen(true)}
          />
        </div>
      </div>

      {/* Object details card */}
      <Card>
        <Heading tag="h2" size="sm" className="mb-3">
          Object details
        </Heading>
        <div className="flex flex-col gap-1">
          <DetailRow label="Name" value={objectKey} />
          {metadata && <DetailRow label="Size" value={formatBytes(metadata.sizeBytes)} />}
          <DetailRow label="Bucket" value={bucketName} />
          <CopyableDetailRow label="S3 Path" value={s3Path} />
          {versionId && <CopyableDetailRow label="Version ID" value={versionId} />}
          {etag && <CopyableDetailRow label="ETag" value={etag} />}
          <div className="flex min-h-9 items-center justify-between">
            <span className="text-sm text-(--color-paragraph-text-subtle)">Retention</span>
            {metadata?.retention ? (
              <span className="flex items-center gap-1.5 font-mono text-xs text-(--color-text-base)">
                <LockIcon size={12} />
                {metadata.retention.mode === 'COMPLIANCE' ? 'Compliance' : 'Governance'}
                {' \u00b7 Expires '}
                {retentionDateFormat.format(new Date(metadata.retention.retainUntilDate))}
              </span>
            ) : (
              <span className="text-sm text-(--color-paragraph-text-subtle)">None</span>
            )}
          </div>
          {metadata?.metadata.description && (
            <div className="flex min-h-9 items-start justify-between gap-4 py-2">
              <span className="shrink-0 text-sm text-(--color-paragraph-text-subtle)">
                Description
              </span>
              <span className="text-right text-sm text-(--color-text-base)">
                {metadata.metadata.description}
              </span>
            </div>
          )}
          <div className="flex min-h-9 items-start justify-between py-2">
            <span className="shrink-0 text-sm text-(--color-paragraph-text-subtle)">Tags</span>
            {tags.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag} color="blue" size="sm">
                    <TagIcon size={10} />
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-sm text-(--color-paragraph-text-subtle)">None</span>
            )}
          </div>
        </div>
      </Card>

      {metadata?.retention && metadata.retention.mode === 'COMPLIANCE' && (
        <div className="mt-6">
          <Alert
            variant="red"
            title="Compliance retention lock"
            description={`This object is locked until ${retentionDateFormat.format(new Date(metadata.retention.retainUntilDate))}. It cannot be deleted before this date.`}
          />
        </div>
      )}

      {/* Version history */}
      <VersionHistoryCard
        versions={objectVersions}
        currentVersionId={versionId}
        bucketName={bucketName}
        region={region}
      />

      {/* API access example card */}
      <Card className="mt-6">
        <Heading tag="h2" size="sm" className="mb-3">
          API access example
        </Heading>
        <CodeBlock code={apiExample} language="bash" />
      </Card>

      {/* Share dialog */}
      <ShareObjectModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        bucketName={bucketName}
        region={region}
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
    <div className="flex min-h-9 items-center justify-between">
      <span className="text-sm text-(--color-paragraph-text-subtle)">{label}</span>
      <span className={`text-sm text-(--color-text-base) ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function CopyableDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4">
      <span className="text-sm text-(--color-paragraph-text-subtle)">{label}</span>
      <CopyableField label="" value={value} />
    </div>
  );
}
