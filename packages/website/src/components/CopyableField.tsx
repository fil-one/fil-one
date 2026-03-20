import { CheckCircleIcon, CopySimpleIcon } from '@phosphor-icons/react/dist/ssr';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';

type CopyableFieldProps = {
  label: string;
  value: string;
};

export function CopyableField({ label, value }: CopyableFieldProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[13px] text-zinc-500">{label}</span>
      <div className="flex-1 overflow-hidden rounded-md bg-zinc-100 px-2.5 py-1.5">
        <span className="font-mono text-xs text-zinc-900">{value}</span>
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
