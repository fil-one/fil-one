import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { AccessKeyPermission, CreateAccessKeyResponse } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { expiresAtFromForm } from '../lib/time.js';

import { AccessKeyExpirationFields } from './AccessKeyExpirationFields.js';
import type { ExpirationOption } from './AccessKeyExpirationFields.js';
import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields.js';
import { Button } from './Button.js';
import { Input } from './Input.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';
import { SaveCredentialsModal } from './SaveCredentialsModal.js';
import { useToast } from './Toast/index.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type AddBucketKeyModalProps = {
  open: boolean;
  onClose: () => void;
  bucketName: string;
  onKeyAdded: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddBucketKeyModal({
  open,
  onClose,
  bucketName,
  onKeyAdded,
}: AddBucketKeyModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>([
    'read',
    'write',
    'list',
    'delete',
  ]);
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  function reset() {
    setKeyName('');
    setPermissions(['read', 'write', 'list', 'delete']);
    setExpiration('never');
    setCustomDate(null);
    setCredentials(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  const createKeyMutation = useMutation({
    mutationFn: (body: {
      keyName: string;
      permissions: AccessKeyPermission[];
      bucketScope: 'specific';
      buckets: string[];
      expiresAt?: string | null;
    }) =>
      apiRequest<CreateAccessKeyResponse>('/access-keys', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      setCredentials({
        accessKeyId: response.accessKeyId,
        secretAccessKey: response.secretAccessKey,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      onKeyAdded();
    },
    onError: (err) => {
      console.error('Failed to create access key:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create access key');
    },
  });

  function handleCreate() {
    if (!keyName.trim() || permissions.length === 0) return;
    createKeyMutation.mutate({
      keyName: keyName.trim(),
      permissions,
      bucketScope: 'specific',
      buckets: [bucketName],
      expiresAt: expiresAtFromForm(expiration, customDate),
    });
  }

  if (credentials) {
    return (
      <SaveCredentialsModal
        open={open}
        onClose={handleClose}
        onDone={handleClose}
        credentials={credentials}
      />
    );
  }

  const canSubmit =
    keyName.trim().length > 0 && permissions.length > 0 && !createKeyMutation.isPending;

  return (
    <Modal open={open} onClose={handleClose} size="md">
      <ModalHeader onClose={handleClose}>Create API key for {bucketName}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          {/* Key name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">Key name</label>
            <Input value={keyName} onChange={setKeyName} placeholder="e.g., Production API Key" />
          </div>

          {/* Permissions */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-zinc-700">Permissions</label>
            <AccessKeyPermissionsFields value={permissions} onChange={setPermissions} />
            {permissions.length === 0 && (
              <p className="text-xs text-red-600">Select at least one permission.</p>
            )}
          </div>

          {/* Expiration */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-zinc-700">Expiration</label>
            <AccessKeyExpirationFields
              value={expiration}
              customDate={customDate}
              onChange={setExpiration}
              onDateChange={setCustomDate}
            />
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button variant="filled" disabled={!canSubmit} onClick={handleCreate}>
            {createKeyMutation.isPending ? 'Creating...' : 'Create & add key'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
