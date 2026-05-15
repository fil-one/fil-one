import { ClipboardIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';

export type CodeBlockProps = {
  code: string;
  language?: string;
  className?: string;
};

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const { copied, copy } = useCopyToClipboard();

  const CopyIcon = copied ? CheckIcon : ClipboardIcon;

  return (
    <div
      className={clsx(
        'relative rounded-lg border border-zinc-200 bg-zinc-100/60 p-4 font-mono text-[11px] leading-5 text-zinc-800',
        className,
      )}
    >
      {/* Top bar: language label + copy button */}
      <div className="mb-3 flex items-center justify-between">
        {language ? <span className="text-xs text-zinc-600">{language}</span> : <span />}
        <button
          type="button"
          onClick={() => void copy(code)}
          aria-label={copied ? 'Copied!' : 'Copy code'}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-1"
        >
          <CopyIcon width={14} height={14} />
          <span>{copied ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>

      {/* Code content */}
      <pre className="overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}
