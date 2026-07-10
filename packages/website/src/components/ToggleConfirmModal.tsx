import { Button } from './Button.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';

export type ToggleConfirmModalProps = {
  enabled: boolean;
  pending: boolean;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/** RAG enable/disable confirmation modal for a bucket. */
export function ToggleConfirmModal({
  enabled,
  pending,
  open,
  onClose,
  onConfirm,
}: ToggleConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="sm" testId="toggle-confirm-modal">
      <ModalHeader onClose={onClose}>
        {enabled ? 'Disable RAG Pipeline?' : 'Enable RAG Pipeline?'}
      </ModalHeader>
      <ModalBody>
        {enabled ? (
          <p className="text-sm text-zinc-600">
            Indexing will stop and this bucket will no longer be queryable via the API. Your
            documents and existing index data are not deleted.
          </p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-zinc-600">
              Files in this bucket will be indexed and become queryable via the API. New uploads are
              indexed automatically.
            </p>
            <p className="text-xs text-zinc-500">Disable at any time.</p>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          data-testid="toggle-confirm-cancel"
          variant="ghost"
          size="md"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          data-testid="toggle-confirm-submit"
          variant={enabled ? 'destructive' : 'primary'}
          size="md"
          onClick={onConfirm}
          disabled={pending}
        >
          {enabled ? 'Disable' : 'Enable'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
