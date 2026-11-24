import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useListingPageScroll } from './use-listing-page-scroll.js';

interface Paging {
  rangeStart: number;
  changing: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

function paging(overrides: Partial<Paging> = {}): Paging {
  return { rangeStart: 1, changing: false, onPrevious: () => {}, onNext: () => {}, ...overrides };
}

/** A listing element whose top edge sits `top` pixels below the viewport's top. */
function listingAt(top: number) {
  const listing = document.createElement('div');
  listing.getBoundingClientRect = () => DOMRect.fromRect({ y: top, height: 2000 });
  const scrollIntoView = vi.fn();
  listing.scrollIntoView = scrollIntoView;
  return { listing, scrollIntoView };
}

function renderScroll(listing: HTMLDivElement, initialProps = paging()) {
  const hook = renderHook((props: Paging) => useListingPageScroll(props), { initialProps });
  hook.result.current.listingRef.current = listing;
  return hook;
}

describe('useListingPageScroll', () => {
  it('scrolls to the listing’s top once the page Next asked for is showing', () => {
    // Scrolled down to the pager, so the listing's top is above the viewport.
    const { listing, scrollIntoView } = listingAt(-1500);
    const { result, rerender } = renderScroll(listing);

    act(() => result.current.paging?.onNext());
    rerender(paging({ changing: true }));
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(paging({ rangeStart: 101 }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('leaves the scroll alone when the listing’s top is already in view', () => {
    const { listing, scrollIntoView } = listingAt(200);
    const { result, rerender } = renderScroll(listing);

    act(() => result.current.paging?.onPrevious());
    rerender(paging({ rangeStart: 101 }));

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('leaves the scroll alone when the range changes without Previous or Next', () => {
    const { listing, scrollIntoView } = listingAt(-1500);
    const { rerender } = renderScroll(listing, paging({ rangeStart: 101 }));

    // Opening a folder from a later page starts that folder at its first row.
    rerender(paging({ rangeStart: 1 }));

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('still calls the pager’s own handler', () => {
    const onNext = vi.fn();
    const { result } = renderHook(() => useListingPageScroll(paging({ onNext })));

    act(() => result.current.paging?.onNext());

    expect(onNext).toHaveBeenCalledOnce();
  });
});
