import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LightbulbIcon } from '@phosphor-icons/react/dist/ssr';

import type {
  AccessKeyBucketScope,
  AccessKeyPermission,
  CreateAccessKeyResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { expiresAtFromForm } from '../lib/time.js';
import { AccessKeyExpirationFields } from './AccessKeyExpirationFields.js';
import type { ExpirationOption } from './AccessKeyExpirationFields.js';
import { AccessKeyBucketScopeFields } from './AccessKeyBucketScopeFields.js';
import { AccessKeyPermissionsFields } from './AccessKeyPermissionsFields.js';
import { Button } from './Button.js';
import { Input } from './Input.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';
import { SaveCredentialsModal } from './SaveCredentialsModal.js';
import { useToast } from './Toast/index.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type CreateAccessKeyModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called after the user acknowledges the credentials screen. */
  onDone: (response: CreateAccessKeyResponse) => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateAccessKeyModal({ open, onClose, onDone }: CreateAccessKeyModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<'form' | 'credentials'>('form');
  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<AccessKeyPermission[]>([
    'read',
    'write',
    'list',
    'delete',
  ]);
  const [bucketScope, setBucketScope] = useState<AccessKeyBucketScope>('all');
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>([]);
  const [expiration, setExpiration] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [result, setResult] = useState<CreateAccessKeyResponse | null>(null);

  function reset() {
    setStep('form');
    setKeyName('');
    setPermissions(['read', 'write', 'list', 'delete']);
    setBucketScope('all');
    setSelectedBuckets([]);
    setExpiration('never');
    setCustomDate(null);
    setResult(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  const createKeyMutation = useMutation({
    mutationFn: (body: {
      keyName: string;
      permissions: AccessKeyPermission[];
      bucketScope: AccessKeyBucketScope;
      buckets?: string[];
      expiresAt?: string | null;
    }) =>
      apiRequest<CreateAccessKeyResponse>('/access-keys', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      setResult(response);
      setStep('credentials');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create access key');
    },
  });

  function handleCreate() {
    if (!keyName.trim() || permissions.length === 0) return;
    createKeyMutation.mutate({
      keyName: keyName.trim(),
      permissions,
      bucketScope,
      buckets: bucketScope === 'specific' ? selectedBuckets : undefined,
      expiresAt: expiresAtFromForm(expiration, customDate),
    });
  }

  function handleDone() {
    if (result) onDone(result);
    reset();
  }

  if (step === 'credentials' && result) {
    return (
      <SaveCredentialsModal
        open={open}
        onDone={handleDone}
        credentials={{ accessKeyId: result.accessKeyId, secretAccessKey: result.secretAccessKey }}
      />
    );
  }

  const bucketsValid = bucketScope === 'all' || selectedBuckets.length > 0;
  const canSubmit =
    keyName.trim().length > 0 &&
    permissions.length > 0 &&
    bucketsValid &&
    !createKeyMutation.isPending;

  return (
    <Modal open={open} onClose={handleClose} size="lg">
      <ModalHeader onClose={handleClose}>Create API key</ModalHeader>
      <ModalBody>
        <div className="flex gap-6">
          {/* Left: form fields */}
          <div className="flex flex-1 flex-col gap-5">
            {/* Key name */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">Key name</label>
              <Input value={keyName} onChange={setKeyName} placeholder="e.g., Production API Key" />
              <p className="text-xs text-zinc-500">
                A descriptive name helps identify this key in your list.
              </p>
            </div>

            {/* Permissions */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-zinc-700">What can this key do?</label>
              <AccessKeyPermissionsFields value={permissions} onChange={setPermissions} />
              {permissions.length === 0 && (
                <p className="text-xs text-red-600">Select at least one permission.</p>
              )}
            </div>

            {/* Bucket scope */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-zinc-700">
                Which buckets can this key access?
              </label>
              <p className="text-xs text-zinc-500">
                Restrict access to specific buckets or allow all.
              </p>
              <AccessKeyBucketScopeFields
                bucketScope={bucketScope}
                onBucketScopeChange={setBucketScope}
                selectedBuckets={selectedBuckets}
                onSelectedBucketsChange={setSelectedBuckets}
              />
            </div>

            {/* Expiration */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-zinc-700">When should it expire?</label>
              <p className="text-xs text-zinc-500">Set an expiration date for added security.</p>
              <AccessKeyExpirationFields
                value={expiration}
                customDate={customDate}
                onChange={setExpiration}
                onDateChange={setCustomDate}
              />
            </div>
          </div>

          {/* Right: info panel */}
          <div className="w-56 shrink-0">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
              <div className="mb-3 flex items-center gap-2">
                <LightbulbIcon size={16} className="text-zinc-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Good to know
                </span>
              </div>
              <div className="flex flex-col gap-4 text-xs text-zinc-600">
                <div>
                  <p className="mb-1 font-medium text-zinc-800">Keep your secret safe</p>
                  <p>
                    Your secret access key grants full access to your data. Never share it with
                    anyone, including support. Store it in a password manager or secrets vault.
                  </p>
                </div>
                <div>
                  <p className="mb-1 font-medium text-zinc-800">Scope by bucket</p>
                  <p>
                    Restrict keys to specific buckets to follow the principle of least privilege.
                  </p>
                </div>
                <div>
                  <p className="mb-1 font-medium text-zinc-800">Set an expiry</p>
                  <p>
                    Keys can be set to expire automatically. Use short-lived keys for temporary
                    access.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={handleCreate}>
            {createKeyMutation.isPending ? 'Creating...' : 'Create key'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
