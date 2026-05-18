import { Alert } from './Alert.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';
import { Button } from './Button.js';
import { CopyButton } from './CopyButton.js';

export type RecoveryCodeModalProps = {
  open: boolean;
  onDone: () => void;
  code: string;
};

export function RecoveryCodeModal({ open, onDone, code }: RecoveryCodeModalProps) {
  return (
    <Modal open={open} onClose={() => {}} size="md">
      <ModalHeader>Save your recovery code</ModalHeader>
      <ModalBody>
        <div className="mb-4">
          <Alert
            variant="amber"
            description="This code will not be shown again. Save it somewhere safe — you can use it once to sign in if you lose your authenticator. After using it, you'll need to generate a new one."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-(--color-text-base)">Recovery code</p>
          <div className="flex items-center gap-2">
            <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-(--input-border-color) bg-zinc-50 px-3">
              <span className="truncate font-mono text-xs text-(--color-text-base)">{code}</span>
            </div>
            <CopyButton size="md" value={code} />
          </div>
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button variant="primary" onClick={onDone}>
          I&apos;ve saved this code
        </Button>
      </ModalFooter>
    </Modal>
  );
}
