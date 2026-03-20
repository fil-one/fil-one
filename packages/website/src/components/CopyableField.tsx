import { CheckCircleIcon, CopySimpleIcon } from '@phosphor-icons/react/dist/ssr';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';

type CopyableFieldProps = {
  label: string;
  value: string;
};

export function CopyableField({ label, value }: CopyableFieldProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
      <div>
        <p className="text-xs text-zinc-500">{label}</p>
        <p className="mt-0.5 font-mono text-sm text-zinc-900">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => void copy(value)}
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:text-zinc-600"
      >
        {copied ? (
          <CheckCircleIcon size={16} className="text-green-500" />
        ) : (
          <CopySimpleIcon size={16} />
        )}
      </button>
    </div>
  );
}
