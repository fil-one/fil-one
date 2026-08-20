import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PageLayout } from '../components/PageLayout.js';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconButton } from '../components/IconButton';
import { Link as ExternalLink } from '../components/Link';
import { Spinner } from '../components/Spinner';
import { Table } from '../components/Table/Table';
import { useToast } from '../components/Toast';
import { EmptyStateCard } from '../components/EmptyStateCard';

import type { ListBucketsResponse, S3Region } from '@filone/shared';
import { ApiErrorCode, DOCS_URL, S3_REGION, getRegionLabel } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDate } from '../lib/time.js';
import { queryKeys } from '../lib/query-client.js';

// Linked from the "bucket is not empty" toast, next to the thing it explains —
// the docs page covers emptying a bucket with the S3 CLI.
const EMPTY_BUCKET_DOCS_URL = `${DOCS_URL}/storage/objects#deleting-objects`;

// A non-empty bucket keeps its longer-lived toast open long enough to read the
// explanation and click through to the docs.
const NOT_EMPTY_TOAST_DURATION_MS = 12_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BucketsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDeleteBucket, setConfirmDeleteBucket] = useState<string | null>(null);

  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.buckets,
    queryFn: () => apiRequest<ListBucketsResponse>('/buckets'),
  });
  const buckets = data?.buckets ?? [];

  const deleteBucketMutation = useMutation({
    mutationFn: (bucketName: string) =>
      apiRequest(`/buckets/${encodeURIComponent(bucketName)}`, { method: 'DELETE' }),
    onSuccess: (_, bucketName) => {
      // Optimistically remove from cache, then confirm with a background refetch
      queryClient.setQueryData<ListBucketsResponse>(queryKeys.buckets, (old) =>
        old ? { buckets: old.buckets.filter((b) => b.bucketName !== bucketName) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(`Bucket "${bucketName}" deleted`);
    },
    onError: (err, bucketName) => {
      // S3 refuses to delete a bucket that still holds objects or object versions.
      // That is a user-fixable problem, so say what to do and link the docs rather
      // than passing the raw API message through.
      if ((err as { code?: string }).code === ApiErrorCode.BUCKET_NOT_EMPTY) {
        toast.error(
          <>
            Bucket &ldquo;{bucketName}&rdquo; is not empty. Delete its objects and object versions
            first —{' '}
            <ExternalLink href={EMPTY_BUCKET_DOCS_URL} variant="accent">
              how to empty a bucket
            </ExternalLink>
          </>,
          { duration: NOT_EMPTY_TOAST_DURATION_MS },
        );
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to delete bucket');
    },
  });

  async function confirmDeleteBucketAction() {
    if (!confirmDeleteBucket) return;
    try {
      await deleteBucketMutation.mutateAsync(confirmDeleteBucket);
    } catch {
      // error handled by mutation.onError
    }
  }

  if (isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading buckets" size={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <PageLayout title="Buckets" description="Organize and manage your storage containers">
        <Alert variant="red" description={error?.message ?? 'Failed to load buckets'} />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Buckets"
      description="Organize and manage your storage containers"
      action={
        <Button
          id="buckets-create-button"
          variant="ghost"
          size="sm"
          icon={PlusIcon}
          onClick={() => navigate({ to: '/buckets/create' })}
        >
          Create bucket
        </Button>
      }
    >
      {/* Content: empty state or table */}
      {buckets.length === 0 ? (
        <EmptyStateCard
          icon={DatabaseIcon}
          title="No buckets yet"
          description="Create your first bucket to start storing objects"
        >
          <Button
            id="buckets-empty-create-button"
            variant="primary"
            icon={PlusIcon}
            onClick={() => navigate({ to: '/buckets/create' })}
          >
            Create bucket
          </Button>
        </EmptyStateCard>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Region</Table.Head>
              <Table.Head>Created</Table.Head>
              <Table.Head>Visibility</Table.Head>
              <Table.Head>Features</Table.Head>
              <Table.Head aria-label="Actions" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {buckets.map((bucket) => (
              <Table.Row
                key={bucket.bucketName}
                data-testid="bucket-row"
                data-bucket-name={bucket.bucketName}
              >
                <Table.Cell>
                  <Link
                    to="/buckets/$bucketName"
                    params={{ bucketName: bucket.bucketName }}
                    search={{ region: bucket.region as S3Region }}
                    data-testid="bucket-link"
                    className="font-medium text-zinc-900 hover:text-brand-600"
                  >
                    {bucket.bucketName}
                  </Link>
                </Table.Cell>
                <Table.Cell className="text-xs">
                  <p className="font-medium text-zinc-900">{getRegionLabel(bucket.region)}</p>
                  <p className="text-zinc-500">{bucket.region ?? S3_REGION}</p>
                </Table.Cell>
                <Table.Cell className="text-zinc-600">{formatDate(bucket.createdAt)}</Table.Cell>
                <Table.Cell>
                  {bucket.isPublic ? (
                    <Badge color="green" size="sm" weight="medium">
                      Public
                    </Badge>
                  ) : (
                    <Badge color="grey" size="sm" weight="medium">
                      Private
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <div className="flex flex-wrap gap-1.5">
                    {bucket.versioning && (
                      <Badge color="blue" size="sm" weight="medium">
                        Versioned
                      </Badge>
                    )}
                    {bucket.objectLockEnabled && (
                      <Badge color="amber" size="sm" weight="medium">
                        Object Lock
                      </Badge>
                    )}
                    {!bucket.versioning && !bucket.objectLockEnabled && (
                      <span className="text-xs text-zinc-400">&mdash;</span>
                    )}
                  </div>
                </Table.Cell>
                <Table.Cell className="text-right">
                  <IconButton
                    icon={TrashIcon}
                    aria-label={`Delete bucket ${bucket.bucketName}`}
                    onClick={() => setConfirmDeleteBucket(bucket.bucketName)}
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <ConfirmDialog
        open={confirmDeleteBucket !== null}
        onClose={() => setConfirmDeleteBucket(null)}
        onConfirm={confirmDeleteBucketAction}
        title="Delete bucket"
        description="This bucket will be permanently deleted. The bucket must be empty — delete its objects and object versions first."
        confirmLabel="Delete bucket"
      />
    </PageLayout>
  );
}
