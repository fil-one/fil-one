import { useNavigate } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PageLayout } from '../components/PageLayout.js';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { EmptyStateCard } from '../components/EmptyStateCard';
import { BucketsTable } from '../components/BucketsTable';

import type { ListBucketsResponse } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
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
        old ? { buckets: old.buckets.filter((b) => b.bucketName !== bucketName) } : old,
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
        <BucketsTable
          buckets={buckets}
          onDelete={(bucketName) => deleteBucketMutation.mutate(bucketName)}
        />
      )}
    </PageLayout>
  );
}
