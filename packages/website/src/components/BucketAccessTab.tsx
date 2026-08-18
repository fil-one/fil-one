import { useState } from 'react';
import { PlusIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { AccessKey, ListAccessKeysResponse, S3Region } from '@filone/shared';

import { apiRequest } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { useToast } from './Toast';
import { AccessEndpointsCard } from './AccessEndpointsCard';
import { AccessKeysTable } from './AccessKeysTable';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Spinner } from './Spinner';

export type BucketAccessTabProps = {
  bucketName: string;
  s3Endpoint: string;
  region: S3Region;
  accessKeys: AccessKey[];
  accessKeysLoading: boolean;
  onCreateOpen: () => void;
};

export function BucketAccessTab({
  bucketName,
  s3Endpoint,
  region,
  accessKeys,
  accessKeysLoading,
  onCreateOpen,
}: BucketAccessTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/access-keys/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<ListAccessKeysResponse>(
        queryKeys.bucketAccessKeys(bucketName, region),
        (old) => (old ? { keys: old.keys.filter((k) => k.id !== id) } : old),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success('Access key deleted');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete key');
    },
  });

  async function confirmDeleteKeyAction() {
    if (!confirmDeleteKey) return;
    try {
      await deleteKeyMutation.mutateAsync(confirmDeleteKey);
    } catch {
      // error handled by mutation.onError
    }
  }

  return (
    <div className="mt-4">
      {/* API keys section */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium text-zinc-900">API keys</h2>
          <p className="text-sm text-zinc-500">Keys with access to this bucket</p>
        </div>
        <Button variant="ghost" size="sm" icon={PlusIcon} onClick={onCreateOpen}>
          Add key
        </Button>
      </div>

      {accessKeysLoading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner ariaLabel="Loading access keys" size={24} />
        </div>
      ) : (
        <AccessKeysTable
          keys={accessKeys}
          showPermissions
          onDelete={async (id) => setConfirmDeleteKey(id)}
          onCreateOpen={onCreateOpen}
          emptyTitle="No access keys yet"
          emptyDescription="Create an access key to connect via the S3 API"
        />
      )}

      {/* Access endpoints section */}
      <div className="mt-8">
        <AccessEndpointsCard
          s3Endpoint={s3Endpoint}
          s3Path={`s3://${bucketName}`}
          region={region}
        />
      </div>

      <ConfirmDialog
        open={confirmDeleteKey !== null}
        onClose={() => setConfirmDeleteKey(null)}
        onConfirm={confirmDeleteKeyAction}
        title="Delete access key"
        description="This access key will be permanently revoked. Any applications using it will lose access immediately."
        confirmLabel="Delete key"
      />
    </div>
  );
}
