import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from './Button';

export type ListingPagerProps = {
  /** One-based position of the page's first and last rows. */
  rangeStart: number;
  rangeEnd: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** A page change is waiting on the server; both controls hold until it lands. */
  changing?: boolean;
  /** Names what is being paged, for the navigation landmark. */
  label: string;
};

/**
 * Previous and next for a list whose source hands out one page at a time.
 *
 * There are no page numbers and no total: a cursor-paged source such as an S3
 * listing knows only whether a next page exists, so the label gives the rows
 * on screen instead. Renders nothing when everything fits on one page.
 */
export function ListingPager({
  rangeStart,
  rangeEnd,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  changing = false,
  label,
}: ListingPagerProps) {
  if (!hasPrevious && !hasNext) return null;

  return (
    <nav aria-label={label} className="mt-3 flex items-center justify-between gap-2">
      {/* Announced so a screen reader hears where Next or Previous landed. */}
      <p
        className="text-ui whitespace-nowrap text-zinc-500"
        aria-live="polite"
        data-testid="listing-pager-range"
      >
        {rangeEnd >= rangeStart
          ? `Showing ${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()}`
          : 'No rows on this page'}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="tertiary"
          size="sm"
          icon={CaretLeftIcon}
          iconPosition="left"
          disabled={!hasPrevious || changing}
          onClick={onPrevious}
          data-testid="listing-pager-previous"
        >
          Previous
        </Button>
        <Button
          variant="tertiary"
          size="sm"
          icon={CaretRightIcon}
          iconPosition="right"
          disabled={!hasNext || changing}
          onClick={onNext}
          data-testid="listing-pager-next"
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
