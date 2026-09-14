import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { canRetainAccessKey } from '@filone/shared';
import type { AccessKey, RotateAccessKeyResponse } from '@filone/shared';

import { useToast } from '../components/Toast/index.js';
import { apiRequest } from './api.js';
import { queryClient, queryKeys } from './query-client.js';
import { useKeyActionScope } from './use-key-scope.js';
import { useHasPermission, usePermissions } from './use-permissions.js';

/** The credential a rotation hands back, shown once and then gone. */
interface NewCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Reissue a key's credential and keep everything else about it.
 *
 * Three pieces of state rather than one, because the flow has three moments a
 * caller can be in: deciding, holding a secret, and neither. Collapsing them
 * would make "confirm open" and "secret on screen" the same fact, and the
 * secret has to survive the dialog closing.
 */
export function useKeyRotation(): {
  /** The key a confirmation is open for, or null. */
  pendingKeyId: string | null;
  /** Open the confirmation for a key. */
  request: (keyId: string) => void;
  /** Close it without rotating. */
  cancel: () => void;
  /** Rotate the pending key. Refusals are reported through a toast. */
  confirm: () => Promise<void>;
  /** True while a rotation is in flight, so a second confirm does nothing. */
  rotating: boolean;
  /** The replacement's credential while it is on screen. */
  credentials: NewCredentials | null;
  /** The caller has saved it. */
  dismissCredentials: () => void;
  /** Whether this caller may reissue this key. */
  canRotate: (key: AccessKey) => boolean;
} {
  const { toast } = useToast();
  const mayCreate = useHasPermission('keys.create');
  const { mayRevoke } = useKeyActionScope();
  const { role } = usePermissions();

  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<NewCredentials | null>(null);

  const rotate = useMutation({
    mutationFn: (keyId: string) =>
      apiRequest<RotateAccessKeyResponse>(`/access-keys/${keyId}/rotate`, { method: 'POST' }),
    onSuccess: (response) => {
      // The replacement carries a new id, so the row the list holds is gone and
      // a filtered cache update cannot describe the result. Refetch instead.
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      setCredentials({
        accessKeyId: response.accessKeyId,
        secretAccessKey: response.secretAccessKey,
      });
      // The replacement is live either way. That the old key survived is the
      // only part the caller has to act on, and it is theirs to delete.
      if (!response.previousKeyRevoked) {
        toast.error(
          `The new credentials for ${response.keyName} are ready, but the key they replace is still active. Delete it from the list.`,
        );
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to rotate key');
    },
  });

  return {
    pendingKeyId,
    request: (keyId: string) => setPendingKeyId(keyId),
    cancel: () => setPendingKeyId(null),
    confirm: async () => {
      // `isPending` rather than a flag of our own: a second confirm while the
      // first is in flight would mint two replacements and revoke the wrong one.
      if (!pendingKeyId || rotate.isPending) return;
      try {
        await rotate.mutateAsync(pendingKeyId);
      } catch {
        // reported by onError
      }
    },
    rotating: rotate.isPending,
    credentials,
    dismissCredentials: () => {
      setCredentials(null);
      setPendingKeyId(null);
    },
    /**
     * A key is rotatable when its holder could mint it today: the replacement
     * is a fresh credential, and the server refuses one carrying more than the
     * caller's role grants. Same function, so the menu hides what would 403.
     */
    canRotate: (key: AccessKey) =>
      mayCreate && mayRevoke(key) && role !== undefined && canRetainAccessKey(role, key).retained,
  };
}
