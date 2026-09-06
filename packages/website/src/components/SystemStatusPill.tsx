import { useQuery } from '@tanstack/react-query';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

import { INSTATUS_PAGE_URL, fetchInstatusSummary, getStatusDisplay } from '../lib/instatus.js';
import { queryKeys } from '../lib/query-client.js';
import { dotColorStyles, textColorStyles } from './StatusIndicator.js';

const STATUS_REFETCH_MS = 60_000;

/**
 * System status for the content window's bottom bar: a bare coloured dot that
 * expands on hover (and on keyboard focus) to reveal the label, still linking to
 * the status page. The compact form the sidebar footer used to carry, made to
 * sit quietly at the end of a toolbar until someone looks at it.
 *
 * Renders nothing until the first read lands, the way the sidebar version did:
 * a dot with no known colour would be a status of its own.
 */
export function SystemStatusPill() {
  const { data, isPending } = useQuery({
    queryKey: queryKeys.instatusSummary,
    queryFn: fetchInstatusSummary,
    staleTime: STATUS_REFETCH_MS,
    refetchInterval: STATUS_REFETCH_MS,
  });

  if (isPending || !data) return null;

  const display = getStatusDisplay(data.page.status);

  return (
    <a
      href={INSTATUS_PAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="system-status"
      aria-label={`System status: ${display.label}`}
      className="group flex items-center rounded-md px-1.5 py-1 hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none"
    >
      <span className="flex size-4 flex-shrink-0 items-center justify-center" aria-hidden="true">
        <span className="relative flex size-2">
          {display.color === 'green' && (
            <span className="absolute -inset-0.5 inline-flex animate-ping rounded-full bg-green-400 opacity-40 [animation-duration:2s]" />
          )}
          <span className={clsx('relative size-2 rounded-full', dotColorStyles[display.color])} />
        </span>
      </span>
      {/* Hidden until hover/focus, then it slides open. `max-w` animates where
          `width:auto` cannot; the label is short, so a generous ceiling is safe. */}
      <span
        className={clsx(
          'max-w-0 overflow-hidden whitespace-nowrap text-xs opacity-0 transition-[max-width,margin-left,opacity] duration-200',
          'group-hover:ml-1.5 group-hover:max-w-40 group-hover:opacity-100',
          'group-focus-visible:ml-1.5 group-focus-visible:max-w-40 group-focus-visible:opacity-100',
          textColorStyles[display.color],
        )}
      >
        {display.label}
      </span>
      <ArrowUpRightIcon
        className={clsx(
          'ml-1 max-w-0 flex-shrink-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-200',
          'group-hover:max-w-4 group-hover:opacity-100',
          'group-focus-visible:max-w-4 group-focus-visible:opacity-100',
          textColorStyles[display.color],
        )}
        width={12}
        height={12}
        aria-hidden="true"
      />
    </a>
  );
}
