import { useNavigate } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';

import type { ListBucketsResponse } from '@filone/shared';
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
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error?.message ?? 'Failed to load buckets'}
        </div>
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
          variant="primary"
          icon={PlusIcon}
          onClick={() => navigate({ to: '/buckets/create' })}
        >
          Create bucket
        </Button>
      </div>

      {/* Content: empty state or table */}
      {buckets.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
          <DatabaseIcon size={48} className="mb-4 text-zinc-300" aria-hidden="true" />
          <p className="mb-1 text-base font-medium text-zinc-700">No buckets yet</p>
          <p className="mb-6 text-sm text-zinc-500">
            Create your first bucket to start storing objects
          </p>
          <Button
            variant="primary"
            icon={PlusIcon}
            onClick={() => navigate({ to: '/buckets/create' })}
          >
            Create bucket
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Region
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Created
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Visibility
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Features
                </th>
                <th className="px-4 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr
                  key={bucket.name}
                  className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                >
                  <td className="px-4 py-3">
                    <Link
                      to="/buckets/$bucketName"
                      params={{ bucketName: bucket.name }}
                      className="font-medium text-zinc-900 hover:text-brand-600"
                    >
                      {bucket.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{bucket.region}</td>
                  <td className="px-4 py-3 text-zinc-600">{formatDate(bucket.createdAt)}</td>
                  <td className="px-4 py-3">
                    {bucket.isPublic ? (
                      <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                        Public
                      </span>
                    ) : (
                      <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                        Private
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {bucket.versioning && (
                        <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                          Versioned
                        </span>
                      )}
                      {bucket.objectLockEnabled && (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                          Object Lock
                        </span>
                      )}
                      {!bucket.versioning && !bucket.objectLockEnabled && (
                        <span className="text-xs text-zinc-400">&mdash;</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      aria-label={`Delete bucket ${bucket.name}`}
                      onClick={() => deleteBucketMutation.mutate(bucket.name)}
                      // TODO: enable bucket deletion after Aurora implements this operation
                      // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
                      // disabled={
                      //   deleteBucketMutation.isPending &&
                      //   deleteBucketMutation.variables === bucket.name
                      // }
                      disabled
                      title="Deleting buckets is not available yet"
                      className="text-zinc-400 hover:text-red-500 disabled:opacity-50"
                    >
                      <TrashIcon size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
