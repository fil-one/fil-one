import { useEffect, useState } from 'react';
import { ArrowClockwiseIcon, LinkIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Spinner } from './Spinner';
import { useObjectActions } from '../lib/use-object-actions';

const EXPIRY_OPTIONS = [
  { label: '1 hour', seconds: 60 * 60, short: '1h' },
  { label: '24 hours', seconds: 60 * 60 * 24, short: '1d' },
  { label: '3 days', seconds: 60 * 60 * 24 * 3, short: '3d' },
  { label: '7 days', seconds: 60 * 60 * 24 * 7, short: '7d' },
] as const;

type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

export type ShareObjectModalProps = {
  open: boolean;
  onClose: () => void;
  bucketName: string;
  objectKey: string;
  versionId?: string;
};

const DEFAULT_OPTION = EXPIRY_OPTIONS[1];

const expiryDateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function ShareObjectModal({
  open,
  onClose,
  bucketName,
  objectKey,
  versionId,
}: ShareObjectModalProps) {
  const [selected, setSelected] = useState<ExpiryOption>(DEFAULT_OPTION);
  const [generated, setGenerated] = useState<{ url: string; expiresAt: string } | null>(null);

  const { generatePresignedUrl, generatingUrl } = useObjectActions({ bucketName });

  useEffect(() => {
    if (!open) {
      setSelected(DEFAULT_OPTION);
      setGenerated(null);
    }
  }, [open]);

  async function handleGenerate(option: ExpiryOption) {
    const result = await generatePresignedUrl(objectKey, {
      versionId,
      expiresIn: option.seconds,
    });
    if (result) {
      setSelected(option);
      setGenerated(result);
    }
  }

  const description = 'Anyone with this link can access the object — no API key required.';

  if (generated) {
    return (
      <Modal open={open} onClose={onClose} size="sm">
        <ModalHeader description={description} onClose={onClose}>
          Share object
        </ModalHeader>
        <ModalBody>
          <GeneratedLink
            url={generated.url}
            expiresAt={generated.expiresAt}
            shortExpiry={selected.short}
            onRegenerate={() => void handleGenerate(selected)}
            regenerating={generatingUrl}
          />
        </ModalBody>
        <ModalFooter fullWidth>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </ModalFooter>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} size="sm">
      <ModalHeader description={description} onClose={onClose}>
        Share object
      </ModalHeader>
      <ModalBody>
        <p className="mb-2 text-[13px] font-medium text-zinc-900">Link expires in</p>
        <ExpirySelector selected={selected} onSelect={setSelected} disabled={generatingUrl} />
      </ModalBody>
      <ModalFooter fullWidth>
        <Button variant="ghost" onClick={onClose} disabled={generatingUrl}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={LinkIcon}
          onClick={() => void handleGenerate(selected)}
          disabled={generatingUrl}
        >
          {generatingUrl ? 'Generating…' : 'Generate link'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ExpirySelector({
  selected,
  onSelect,
  disabled,
}: {
  selected: ExpiryOption;
  onSelect: (option: ExpiryOption) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Link expiry">
      {EXPIRY_OPTIONS.map((option) => {
        const isSelected = option.seconds === selected.seconds;
        return (
          <button
            key={option.seconds}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={disabled}
            onClick={() => onSelect(option)}
            className={clsx(
              'rounded-md border px-3 py-1.5 text-[13px] transition-colors',
              isSelected
                ? 'border-blue-500 bg-blue-50 font-medium text-blue-600'
                : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function GeneratedLink({
  url,
  expiresAt,
  shortExpiry,
  onRegenerate,
  regenerating,
}: {
  url: string;
  expiresAt: string;
  shortExpiry: string;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 overflow-hidden rounded-md bg-zinc-100 px-2.5 py-1.5">
          <span className="block truncate font-mono text-xs text-zinc-900">{url}</span>
        </div>
        <CopyButton value={url} size="md" />
      </div>
      <p className="text-[12px] text-amber-600">
        Copy this link now — it won&rsquo;t be shown again after you close this dialog.
      </p>
      <div className="flex items-center gap-2 text-[13px] text-zinc-500">
        <span>Expires</span>
        <span className="text-zinc-900">{expiryDateFormat.format(new Date(expiresAt))}</span>
        <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">
          {shortExpiry}
        </span>
      </div>
      <button
        type="button"
        onClick={onRegenerate}
        disabled={regenerating}
        className="flex items-center gap-1.5 self-start text-[13px] text-zinc-600 hover:text-zinc-900 disabled:opacity-60"
      >
        {regenerating ? (
          <Spinner ariaLabel="Regenerating link" size={12} />
        ) : (
          <ArrowClockwiseIcon size={12} />
        )}
        Generate a new link
      </button>
    </div>
  );
}
