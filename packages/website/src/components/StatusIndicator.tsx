import { useQuery } from '@tanstack/react-query';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

import { INSTATUS_PAGE_URL, fetchInstatusSummary, getStatusDisplay } from '../lib/instatus.js';
import { queryKeys } from '../lib/query-client.js';

const STATUS_REFETCH_MS = 60_000;

const dotColorStyles = {
  green: 'bg-green-500',
  red: 'bg-red-500',
  blue: 'bg-brand-500',
  amber: 'bg-amber-500',
  grey: 'bg-zinc-400',
} as const;

const textColorStyles = {
  green: 'text-green-700',
  red: 'text-red-700',
  blue: 'text-brand-700',
  amber: 'text-amber-700',
  grey: 'text-zinc-500',
} as const;

type StatusIndicatorProps = {
  /**
   * `row` is the full-width line in the mobile drawer: dot, label, and an arrow
   * that shows on hover, or always on a touch screen, which has no hover.
   * `pill` is the desktop utility bar's form: a bare dot that expands on hover
   * or keyboard focus to reveal the label.
   */
  variant: 'row' | 'pill';
};

/**
 * System status, linking to the status page.
 *
 * Renders nothing until the first read lands: a dot with no known colour would
 * be a status of its own.
 */
export function StatusIndicator({ variant }: StatusIndicatorProps) {
  const { data, isPending } = useQuery({
    queryKey: queryKeys.instatusSummary,
    queryFn: fetchInstatusSummary,
    staleTime: STATUS_REFETCH_MS,
    refetchInterval: STATUS_REFETCH_MS,
  });

  if (isPending || !data) return null;

  const display = getStatusDisplay(data.page.status);

  const dot = (
    <span className="flex size-4 flex-shrink-0 items-center justify-center" aria-hidden="true">
      <span className="relative flex size-2">
        {display.color === 'green' && (
          <span className="absolute -inset-0.5 inline-flex animate-ping rounded-full bg-green-400 opacity-40 [animation-duration:2s] motion-reduce:animate-none" />
        )}
        <span className={clsx('relative size-2 rounded-full', dotColorStyles[display.color])} />
      </span>
    </span>
  );

  if (variant === 'pill') {
    return (
      <a
        href={INSTATUS_PAGE_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="system-status"
        aria-label={`System status: ${display.label}`}
        className="group flex items-center rounded-md px-1.5 py-1 hover:bg-zinc-100 focus-visible:brand-outline"
      >
        {dot}
        {/* Hidden until hover/focus, then it slides open. `max-w` animates where
            `width:auto` cannot; the label is short, so a generous ceiling is safe. */}
        <span
          className={clsx(
            'max-w-0 overflow-hidden whitespace-nowrap text-xs opacity-0 transition-all duration-200 motion-reduce:transition-none',
            'group-hover:ml-1.5 group-hover:max-w-40 group-hover:opacity-100',
            'group-focus-visible:ml-1.5 group-focus-visible:max-w-40 group-focus-visible:opacity-100',
            textColorStyles[display.color],
          )}
        >
          {display.label}
        </span>
        <ArrowUpRightIcon
          className={clsx(
            'ml-1 max-w-0 flex-shrink-0 overflow-hidden opacity-0 transition-all duration-200 motion-reduce:transition-none',
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

  return (
    <a
      href={INSTATUS_PAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="system-status"
      className={clsx(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-zinc-100 focus-visible:brand-outline',
        textColorStyles[display.color],
      )}
    >
      {dot}
      {display.label}
      <ArrowUpRightIcon
        className="ml-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100 pointer-coarse:opacity-100"
        width={12}
        height={12}
        aria-hidden="true"
      />
    </a>
  );
}
