import { useEffect, useRef } from 'react';

/** The parts of a pager's props this hook reads and wraps. */
interface ListingPaging {
  rangeStart: number;
  changing?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

/**
 * Brings the top of the listing back on screen after Previous or Next, since
 * the pager sits under the table and the new page would otherwise open at its
 * bottom. Waits until the new page is showing, and leaves the scroll alone
 * when the listing's top is already in view or the page changed for another
 * reason, such as opening a folder.
 */
export function useListingPageScroll<Paging extends ListingPaging>(paging: Paging | undefined) {
  const listingRef = useRef<HTMLDivElement>(null);
  const pageChangeRequested = useRef(false);
  const changing = paging?.changing ?? false;
  const rangeStart = paging?.rangeStart;

  useEffect(() => {
    const listing = listingRef.current;
    if (!pageChangeRequested.current || changing || !listing) return;
    pageChangeRequested.current = false;
    // The scroll margin is the room the listing keeps above itself when
    // scrolled to, such as for the mobile sticky header, so a top edge inside
    // it counts as hidden.
    const margin = parseFloat(getComputedStyle(listing).scrollMarginTop) || 0;
    if (listing.getBoundingClientRect().top < margin) listing.scrollIntoView({ block: 'start' });
  }, [changing, rangeStart]);

  const pagingWithScroll = paging && {
    ...paging,
    onPrevious: () => {
      pageChangeRequested.current = true;
      paging.onPrevious();
    },
    onNext: () => {
      pageChangeRequested.current = true;
      paging.onNext();
    },
  };
  return { listingRef, paging: pagingWithScroll };
}
