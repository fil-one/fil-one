import { useState } from 'react';

import { ClipboardIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

export type CodeBlockProps = {
  code: string;
  language?: string;
  className?: string;
};

const COPY_RESET_DELAY_MS = 2000;

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_RESET_DELAY_MS);
    } catch {
      // UNKNOWN: No design spec for copy-failure state. Silently failing is the
      // most defensible default — avoids a disruptive error toast for a non-critical action.
    }
  }

  const CopyIcon = copied ? CheckIcon : ClipboardIcon;

  return (
    <div
      className={clsx(
        'relative rounded-lg bg-zinc-950 p-4 font-mono text-sm text-zinc-300',
        className,
      )}
    >
      {/* Top bar: language label + copy button */}
      <div className="mb-3 flex items-center justify-between">
        {language ? <span className="text-xs text-zinc-500">{language}</span> : <span />}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied!' : 'Copy code'}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-1 focus:ring-offset-zinc-950"
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
