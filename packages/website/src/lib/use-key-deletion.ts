import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ListAccessKeysResponse } from '@filone/shared';

import { useToast } from '../components/Toast/index.js';
import { apiRequest } from './api.js';
import { queryClient, queryKeys } from './query-client.js';

/** Copy for the delete-confirmation dialog, adapted to how many keys are selected. */
function deleteDialogCopy(count: number) {
  if (count > 1) {
    return {
      title: `Delete ${count} access keys`,
      description: `These ${count} access keys will be permanently revoked. Any applications using them will lose access immediately.`,
      confirmLabel: `Delete ${count} keys`,
    };
  }
  return {
    title: 'Delete access key',
    description:
      'This access key will be permanently revoked. Any applications using it will lose access immediately.',
    confirmLabel: 'Delete key',
  };
}

/**
 * One confirmation flow for both a single row's Delete and the bulk-select
 * toolbar's Delete: both just hand it a list of ids, one or many.
 */
export function useKeyDeletion(): {
  /** The ids a confirmation is open for, or null. */
  pendingIds: string[] | null;
  /** Open the confirmation for one key. */
  request: (id: string) => void;
  /** Open the confirmation for several keys at once. */
  requestBulk: (ids: string[]) => void;
  /** Close it without deleting. */
  cancel: () => void;
  /** Delete the pending ids. Refusals are reported through a toast. */
  confirm: () => Promise<void>;
  /** Copy for the confirmation dialog, sized to the pending ids. */
  dialogCopy: ReturnType<typeof deleteDialogCopy>;
} {
  const { toast } = useToast();
  const [pendingIds, setPendingIds] = useState<string[] | null>(null);

  const deleteKeys = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => apiRequest(`/access-keys/${id}`, { method: 'DELETE' }))),
    onSuccess: (_, ids) => {
      const removed = new Set(ids);
      queryClient.setQueryData<ListAccessKeysResponse>(queryKeys.accessKeys, (old) =>
        old ? { keys: old.keys.filter((k) => !removed.has(k.id)) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(ids.length === 1 ? 'Access key deleted' : `${ids.length} access keys deleted`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete keys');
    },
  });

  return {
    pendingIds,
    request: (id: string) => setPendingIds([id]),
    requestBulk: (ids: string[]) => setPendingIds(ids),
    cancel: () => setPendingIds(null),
    confirm: async () => {
      if (!pendingIds || deleteKeys.isPending) return;
      try {
        await deleteKeys.mutateAsync(pendingIds);
        setPendingIds(null);
      } catch {
        // reported by onError
      }
    },
    dialogCopy: deleteDialogCopy(pendingIds?.length ?? 0),
  };
}
