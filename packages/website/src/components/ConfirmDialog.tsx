import { useState } from 'react';
import { DialogTitle } from '@headlessui/react';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { Button } from './Button';
import { IconBox } from './IconBox';
import { Spinner } from './Spinner';

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
    <Modal open={open} onClose={loading ? () => {} : onClose} size="sm">
      <ModalBody>
        <div className="flex flex-col items-center gap-3 px-2 pt-6 pb-0 text-center">
          <IconBox icon={WarningCircleIcon} color="red" size="lg" />
          <div className="flex flex-col gap-1">
            <DialogTitle as="p" className="text-base font-medium text-zinc-900">
              {title}
            </DialogTitle>
            <p className="text-sm text-zinc-500">{description}</p>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full gap-3">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void handleConfirm()}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {loading && <Spinner ariaLabel="Processing" size={14} />}
            {confirmLabel}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
