import { useState } from 'react';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '../Button';
import { Dialog, DialogHeader, DialogBody, DialogFooter } from '../Dialog';
import { Spinner } from '../Spinner';

export type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
}: ConfirmDialogProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onClose={loading ? () => {} : onClose} size="sm">
      <DialogHeader onClose={loading ? undefined : onClose}>{title}</DialogHeader>
      <DialogBody>
        <div className="flex items-start gap-3">
          <WarningCircleIcon
            size={20}
            className="mt-0.5 shrink-0 text-red-500"
            aria-hidden="true"
          />
          <p className="text-sm text-zinc-600">{description}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <button
          type="button"
          disabled={loading}
          onClick={() => void handleConfirm()}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {loading && <Spinner ariaLabel="Processing" size={14} />}
          {confirmLabel}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
