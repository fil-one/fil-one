import { CopySimpleIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';

export type CodeBlockProps = {
  code: string;
  language?: string;
  className?: string;
  /**
   * Lighter presentation for inline/stepped contexts: drops the border and
   * language header, and reveals the copy control on hover/focus. Use inside a
   * card that already supplies the surrounding chrome.
   */
  minimal?: boolean;
};

export function CodeBlock({ code, language, className, minimal }: CodeBlockProps) {
  const { copied, copy } = useCopyToClipboard();

  const CopyIcon = copied ? CheckIcon : CopySimpleIcon;

  if (minimal) {
    return (
      <div
        className={clsx(
          'group relative rounded-lg bg-zinc-50 py-2.5 pr-10 pl-3 font-mono text-[11px] leading-5 text-zinc-800',
          className,
        )}
      >
        <button
          type="button"
          onClick={() => void copy(code)}
          aria-label={copied ? 'Copied!' : 'Copy code'}
          className="absolute top-1.5 right-1.5 rounded p-1.5 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-200 hover:text-zinc-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 max-sm:opacity-100"
        >
          <CopyIcon width={14} height={14} />
        </button>
        <pre className="overflow-x-auto">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

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
