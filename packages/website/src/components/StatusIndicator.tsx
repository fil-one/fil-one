import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';

import { INSTATUS_PAGE_URL, fetchInstatusSummary, getStatusDisplay } from '../lib/instatus.js';
import { queryKeys } from '../lib/query-client.js';
import { Tooltip } from './Tooltip.js';

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
  collapsed: boolean;
};

export function StatusIndicator({ collapsed }: StatusIndicatorProps) {
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
          <span className="absolute -inset-0.5 inline-flex animate-ping rounded-full bg-green-400 opacity-40 [animation-duration:2s]" />
        )}
        <span className={clsx('relative size-2 rounded-full', dotColorStyles[display.color])} />
      </span>
    </span>
  );

  if (collapsed) {
    return (
      <Tooltip content={display.label} side="right">
        <a
          href={INSTATUS_PAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`System status: ${display.label}`}
          className="flex w-full items-center justify-center rounded-lg px-3 py-2 hover:bg-zinc-100"
        >
          {dot}
        </a>
      </Tooltip>
    );
  }

  return (
    <a
      href={INSTATUS_PAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={clsx(
        'flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-zinc-100',
        textColorStyles[display.color],
      )}
    >
      {dot}
      {display.label}
    </a>
  );
}
