import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ListAccessKeysResponse } from '@filone/shared';

import { useToast } from '../components/Toast/index.js';
import { apiRequest, errorStatusOf } from './api.js';
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
  /** Delete the pending ids, each on its own; any refusal is reported through a toast. */
  confirm: () => Promise<void>;
  /** Copy for the confirmation dialog, sized to the pending ids. */
  dialogCopy: ReturnType<typeof deleteDialogCopy>;
} {
  const { toast } = useToast();
  const [pendingIds, setPendingIds] = useState<string[] | null>(null);

  const deleteKeys = useMutation({
    // Settled, not all-or-nothing: the deletes run together, so when one fails
    // the others have already happened on the server, and the list has to say
    // so rather than keep showing keys that no longer work.
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiRequest(`/access-keys/${id}`, { method: 'DELETE' })),
      );
      // A 404 means the key is already gone (deleted in another tab, say),
      // which is the outcome asked for, so it counts as deleted.
      const isGone = (result: PromiseSettledResult<unknown>) =>
        result.status === 'fulfilled' || errorStatusOf(result.reason) === 404;
      return {
        deleted: ids.filter((_, index) => isGone(results[index])),
        failures: results.flatMap((result) =>
          result.status === 'rejected' && !isGone(result) ? [result.reason] : [],
        ),
      };
    },
    onSuccess: ({ deleted, failures }) => {
      const removed = new Set(deleted);
      queryClient.setQueryData<ListAccessKeysResponse>(queryKeys.accessKeys, (old) =>
        old ? { keys: old.keys.filter((k) => !removed.has(k.id)) } : old,
      );
      reportOutcome(deleted.length, failures);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
    },
  });

  function reportOutcome(deletedCount: number, failures: unknown[]) {
    if (failures.length === 0) {
      toast.success(
        deletedCount === 1 ? 'Access key deleted' : `${deletedCount} access keys deleted`,
      );
      return;
    }
    // Every distinct reason, so two different refusals are both named.
    const reason = [
      ...new Set(
        failures.map((failure) =>
          failure instanceof Error ? failure.message : 'Failed to delete keys',
        ),
      ),
    ].join('; ');
    if (deletedCount === 0) {
      toast.error(reason);
      return;
    }
    toast.error(`${deletedCount} deleted. ${failures.length} couldn't be deleted: ${reason}`);
  }

  return {
    pendingIds,
    request: (id: string) => setPendingIds([id]),
    requestBulk: (ids: string[]) => setPendingIds(ids),
    cancel: () => setPendingIds(null),
    confirm: async () => {
      if (!pendingIds || deleteKeys.isPending) return;
      // Closed whatever the outcome, as ConfirmDialog closes once this
      // resolves: the toast says what could not be deleted, and the refreshed
      // list shows what is left to retry.
      await deleteKeys.mutateAsync(pendingIds);
      setPendingIds(null);
    },
    dialogCopy: deleteDialogCopy(pendingIds?.length ?? 0),
  };
}
