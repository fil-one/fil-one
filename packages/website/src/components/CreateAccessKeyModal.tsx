import { useState } from 'react';

import { Button } from '@hyperspace/ui/Button';
import { CodeBlock } from '@hyperspace/ui/CodeBlock';
import { Input } from '@hyperspace/ui/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@hyperspace/ui/Modal';
import { useToast } from '@hyperspace/ui/Toast';

import type { CreateAccessKeyResponse } from '@filone/shared';
import { apiRequest } from '../lib/api.js';

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

  const [step, setStep] = useState<'form' | 'credentials'>('form');
  const [keyName, setKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreateAccessKeyResponse | null>(null);

  function reset() {
    setStep('form');
    setKeyName('');
    setCreating(false);
    setResult(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleCreate() {
    if (!keyName.trim()) return;
    setCreating(true);
    try {
      const response = await apiRequest<CreateAccessKeyResponse>('/access-keys', {
        method: 'POST',
        body: JSON.stringify({ keyName: keyName.trim() }),
      });
      setResult(response);
      setStep('credentials');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create access key');
    } finally {
      setCreating(false);
    }
  }

  function handleDone() {
    if (result) onDone(result);
    reset();
  }

  if (step === 'form') {
    return (
      <Modal open={open} onClose={handleClose} size="sm">
        <ModalHeader onClose={handleClose}>Create access key</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">Key name</label>
            <Input value={keyName} onChange={setKeyName} placeholder="e.g. Production, Local dev" />
            <p className="text-xs text-zinc-500">
              A descriptive name to identify where this key is used.
            </p>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button variant="filled" disabled={!keyName.trim() || creating} onClick={handleCreate}>
              {creating ? 'Creating...' : 'Create key'}
            </Button>
          </div>
        </ModalFooter>
      </Modal>
    );
  }

  // Step: credentials
  return (
    <Modal open={open} onClose={handleClose} size="md">
      <ModalHeader>Save your credentials</ModalHeader>
      <ModalBody>
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          This is the only time you&apos;ll be able to see the secret access key. Copy it now.
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
              Access Key ID
            </p>
            <CodeBlock code={result?.accessKeyId ?? ''} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
              Secret Access Key
            </p>
            <CodeBlock code={result?.secretAccessKey ?? ''} />
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex justify-end">
          <Button variant="filled" onClick={handleDone}>
            I&apos;ve saved my credentials
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
