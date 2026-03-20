import { useState } from 'react';

import type { AccessKeyPermission, CreateAccessKeyResponse } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
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

  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>([
    'read',
    'write',
    'list',
    'delete',
  ]);
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);

  function reset() {
    setKeyName('');
    setPermissions(['read', 'write', 'list', 'delete']);
    setExpiration('never');
    setCustomDate(null);
    setCreating(false);
    setCredentials(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleCreate() {
    if (!keyName.trim() || permissions.length === 0) return;
    setCreating(true);
    try {
      const response = await apiRequest<CreateAccessKeyResponse>('/access-keys', {
        method: 'POST',
        body: JSON.stringify({
          keyName: keyName.trim(),
          permissions,
          bucketScope: 'specific',
          buckets: [bucketName],
          expiresAt: expiresAtFromForm(expiration, customDate),
        }),
      });
      setCredentials({
        accessKeyId: response.accessKeyId,
        secretAccessKey: response.secretAccessKey,
      });
      onKeyAdded();
    } catch (err) {
      console.error('Failed to create access key:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create access key');
    } finally {
      setCreating(false);
    }
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

  const canSubmit = keyName.trim().length > 0 && permissions.length > 0 && !creating;

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
            {creating ? 'Creating...' : 'Create & add key'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
