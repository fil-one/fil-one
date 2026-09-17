import { useState } from 'react';

import { DownloadSimpleIcon, EyeIcon, EyeSlashIcon } from '@phosphor-icons/react/dist/ssr';

import { Alert } from './Alert.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';
import { Button } from './Button.js';
import { CopyButton } from './CopyButton.js';
import { IconButton } from './IconButton.js';
import { SplitButton } from './SplitButton.js';
import { downloadText } from '../lib/download.js';

export type SaveCredentialsModalProps = {
  open: boolean;
  onDone: () => void;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
};

export function SaveCredentialsModal({ open, onDone, credentials }: SaveCredentialsModalProps) {
  const [showSecret, setShowSecret] = useState(false);

  function handleDownloadCsv() {
    const csv = [
      'Access Key ID,Secret Access Key',
      `${credentials.accessKeyId},${credentials.secretAccessKey}`,
    ].join('\n');
    downloadText(csv, 'credentials.csv', 'text/csv');
  }

  function handleDownloadEnv() {
    const env = [
      `export AWS_ACCESS_KEY_ID=${credentials.accessKeyId}`,
      `export AWS_SECRET_ACCESS_KEY=${credentials.secretAccessKey}`,
    ].join('\n');
    downloadText(env, 'credentials.env', 'text/plain');
  }

  return (
    <Modal open={open} onClose={() => {}} size="md" testId="save-credentials-modal">
      <ModalHeader>Save your credentials</ModalHeader>
      <ModalBody>
        <div className="mb-4">
          <Alert
            variant="amber"
            description="This is the only time your secret key is shown — copy or download it now. Store it somewhere safe and never share it."
          />
        </div>

        {/* Credential fields */}
        <div className="flex flex-col gap-3">
          {/* Access Key ID */}
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-(--color-text-base)">Access Key ID</p>
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-(--input-border-color) bg-zinc-50 px-3">
                <span className="truncate font-mono text-xs text-(--color-text-base)">
                  {credentials.accessKeyId}
                </span>
              </div>
              <CopyButton size="md" value={credentials.accessKeyId} />
            </div>
          </div>

          {/* Secret Access Key */}
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-(--color-text-base)">Secret Access Key</p>
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-(--input-border-color) bg-zinc-50 px-3">
                <span className="truncate font-mono text-xs text-(--color-text-base)">
                  {showSecret ? credentials.secretAccessKey : '\u2022'.repeat(40)}
                </span>
              </div>
              <IconButton
                icon={showSecret ? EyeSlashIcon : EyeIcon}
                aria-label={showSecret ? 'Hide secret key' : 'Show secret key'}
                onClick={() => setShowSecret((s) => !s)}
              />
              <CopyButton size="md" value={credentials.secretAccessKey} />
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="save-credentials-done-button" variant="ghost" onClick={onDone}>
          Done
        </Button>
        <SplitButton
          label="Download .csv"
          icon={DownloadSimpleIcon}
          onMainClick={handleDownloadCsv}
          items={[{ label: 'Download .env', icon: DownloadSimpleIcon, onClick: handleDownloadEnv }]}
        />
      </ModalFooter>
    </Modal>
  );
}
