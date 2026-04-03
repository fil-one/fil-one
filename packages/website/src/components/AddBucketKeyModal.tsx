import { useState } from 'react';
import { LightbulbIcon } from '@phosphor-icons/react/dist/ssr';

import { useAccessKeyForm } from '../lib/use-access-key-form.js';
import { AccessKeyFormFields } from './AccessKeyFormFields.js';

import type { CreateAccessKeyResponse } from '@filone/shared';

import { Button } from './Button.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';
import { SaveCredentialsModal } from './SaveCredentialsModal.js';

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
  const [credentials, setCredentials] = useState<{
    accessKeyId: string;
    secretAccessKey: string;
  } | null>(null);
  const form = useAccessKeyForm({
    defaultBucket: bucketName,
    onSuccess: (response: CreateAccessKeyResponse) => {
      setCredentials({
        accessKeyId: response.accessKeyId,
        secretAccessKey: response.secretAccessKey,
      });
      onKeyAdded();
    },
  });

  function handleClose() {
    form.reset();
    setCredentials(null);
    onClose();
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

  return (
    <Modal open={open} onClose={handleClose} size="lg">
      <ModalHeader onClose={handleClose}>Create API key for {bucketName}</ModalHeader>
      <ModalBody>
        <div className="flex gap-6">
          {/* Left: form fields */}
          <div className="flex-1">
            <AccessKeyFormFields form={form} />
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
          <Button variant="filled" disabled={!form.canSubmit} onClick={form.handleSubmit}>
            {form.creating ? 'Creating...' : 'Create API key'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
