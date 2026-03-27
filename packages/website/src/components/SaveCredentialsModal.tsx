import { useState } from 'react';

import { WarningCircle, Eye, EyeSlash, DownloadSimple } from '@phosphor-icons/react/dist/ssr';

import { CopyButton } from './CopyButton';
import { IconButton } from './IconButton';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from './Dialog';

export type SaveCredentialsModalProps = {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
};

export function SaveCredentialsModal({
  open,
  onClose,
  onDone,
  credentials,
}: SaveCredentialsModalProps) {
  const [showSecret, setShowSecret] = useState(false);

  function downloadBlob(content: string, filename: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleDownloadCsv() {
    const csv = [
      'Access Key ID,Secret Access Key',
      `${credentials.accessKeyId},${credentials.secretAccessKey}`,
    ].join('\n');
    downloadBlob(csv, 'credentials.csv', 'text/csv');
  }

  function handleDownloadEnv() {
    const env = [
      `export AWS_ACCESS_KEY_ID=${credentials.accessKeyId}`,
      `export AWS_SECRET_ACCESS_KEY=${credentials.secretAccessKey}`,
    ].join('\n');
    downloadBlob(env, 'credentials.env', 'text/plain');
  }

  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader onClose={onClose}>Save your credentials</DialogHeader>
      <DialogBody>
        {/* Warning banner */}
        <div className="mb-4 flex gap-2.5 rounded-lg border border-orange-500/20 bg-orange-500/10 p-3">
          <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-orange-500" />
          <p className="text-xs leading-[18px] text-zinc-900">
            Save your credentials in a safe place. Do not share your secret key with anyone.
          </p>
        </div>

        {/* Credential fields */}
        <div className="flex flex-col gap-3">
          {/* Access Key ID */}
          <div>
            <p className="mb-2 text-[13px] font-medium text-zinc-900">Access Key ID</p>
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 px-3">
                <span className="truncate font-mono text-xs text-zinc-900">
                  {credentials.accessKeyId}
                </span>
              </div>
              <CopyButton
                value={credentials.accessKeyId}
                ariaLabel="Copy Access Key ID"
                className=""
              />
            </div>
          </div>

          {/* Secret Access Key */}
          <div>
            <p className="mb-2 text-[13px] font-medium text-zinc-900">Secret Access Key</p>
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 px-3">
                <span className="truncate font-mono text-xs text-zinc-900">
                  {showSecret ? credentials.secretAccessKey : '\u2022'.repeat(40)}
                </span>
              </div>
              <IconButton
                onClick={() => setShowSecret((s) => !s)}
                aria-label={showSecret ? 'Hide secret key' : 'Show secret key'}
              >
                {showSecret ? <EyeSlash size={16} /> : <Eye size={16} />}
              </IconButton>
              <CopyButton
                value={credentials.secretAccessKey}
                ariaLabel="Copy Secret Access Key"
                className=""
              />
            </div>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <div className="flex w-full gap-2">
          <button
            type="button"
            onClick={onDone}
            className="flex h-9 flex-1 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 text-[13px] font-medium text-zinc-900 shadow-sm transition-colors hover:bg-zinc-100"
          >
            Done
          </button>
          <button
            type="button"
            onClick={handleDownloadCsv}
            className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-gradient-to-br from-[#0080ff] to-[#256af4] text-[13px] font-medium text-white shadow-sm transition-colors hover:from-[#0070e0] hover:to-[#2060d8]"
          >
            <DownloadSimple size={16} weight="bold" />
            Download .csv
          </button>
          <button
            type="button"
            onClick={handleDownloadEnv}
            className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-gradient-to-br from-[#0080ff] to-[#256af4] text-[13px] font-medium text-white shadow-sm transition-colors hover:from-[#0070e0] hover:to-[#2060d8]"
          >
            <DownloadSimple size={16} weight="bold" />
            Download .env
          </button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
