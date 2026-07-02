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
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                Pricing
              </p>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-6">
                  <span className="text-sm text-zinc-600">Per TB stored (with indexing)</span>
                  <span className="flex-shrink-0 text-sm font-semibold text-zinc-900">
                    $15 / TB / month
                  </span>
                </div>
                <div className="flex items-center justify-between gap-6">
                  <span className="text-sm text-zinc-600">LLM / embedding costs</span>
                  <span className="flex-shrink-0 text-sm font-semibold text-zinc-900">
                    Included
                  </span>
                </div>
              </div>
            </div>
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
