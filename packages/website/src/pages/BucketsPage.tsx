import { useNavigate } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { Spinner } from '../components/Spinner';
import { Table } from '../components/Table/Table';
import { useToast } from '../components/Toast';
import { EmptyStateCard } from '../components/EmptyStateCard';

import type { ListBucketsResponse } from '@filone/shared';
import { S3_REGION, getRegionLabel } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDate } from '../lib/time.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BucketsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
        old ? { buckets: old.buckets.filter((b) => b.name !== bucketName) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(`Bucket "${bucketName}" deleted`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete bucket');
    },
  });

  if (isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading buckets" size={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="px-10 pt-10">
        <Alert variant="red" description={error?.message ?? 'Failed to load buckets'} />
      </div>
    );
  }

  return (
    <div className="px-10 pt-10">
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between">
        <Heading tag="h1" size="xl" description="Organize and manage your storage containers">
          Buckets
        </Heading>
        <Button
          variant="ghost"
          size="sm"
          icon={PlusIcon}
          onClick={() => navigate({ to: '/buckets/create' })}
        >
          Create bucket
        </Button>
      </div>

      {/* Content: empty state or table */}
      {buckets.length === 0 ? (
        <EmptyStateCard
          icon={DatabaseIcon}
          title="No buckets yet"
          description="Create your first bucket to start storing objects"
        >
          <Button
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
            <tr>
              <Table.Head>Name</Table.Head>
              <Table.Head>Region</Table.Head>
              <Table.Head>Created</Table.Head>
              <Table.Head>Visibility</Table.Head>
              <Table.Head>Features</Table.Head>
              <Table.Head aria-label="Actions" />
            </tr>
          </Table.Header>
          <Table.Body>
            {buckets.map((bucket) => (
              <Table.Row key={bucket.name}>
                <Table.Cell>
                  <Link
                    to="/buckets/$bucketName"
                    params={{ bucketName: bucket.name }}
                    className="font-medium text-zinc-900 hover:text-brand-600"
                  >
                    {bucket.name}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <p className="text-xs font-medium text-zinc-900">
                    {getRegionLabel(bucket.region)}
                  </p>
                  <p className="text-xs text-zinc-500">{bucket.region ?? S3_REGION}</p>
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
                    aria-label={`Delete bucket ${bucket.name}`}
                    onClick={() => deleteBucketMutation.mutate(bucket.name)}
                    // TODO: enable bucket deletion after Aurora implements this operation
                    // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
                    disabled
                    title="Deleting buckets is not available yet"
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  );
}
