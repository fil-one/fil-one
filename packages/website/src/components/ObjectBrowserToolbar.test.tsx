import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ObjectSearchBar } from './ObjectBrowserToolbar';

type SearchBarProps = ComponentProps<typeof ObjectSearchBar>;
type Paging = NonNullable<SearchBarProps['paging']>;

/** The first page of a folder with more pages after it. */
function firstPage(overrides: Partial<Paging> = {}): Paging {
  return {
    rangeStart: 1,
    rangeEnd: 100,
    hasPrevious: false,
    hasNext: true,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  };
}

function searchBar(overrides: Partial<SearchBarProps> = {}) {
  return (
    <ObjectSearchBar
      search=""
      listedSearch=""
      place="folder"
      onSearchChange={vi.fn()}
      paging={firstPage()}
      rowCount={100}
      {...overrides}
    />
  );
}

describe('ObjectSearchBar count', () => {
  it('holds the last count while the next page loads', () => {
    const { rerender } = render(searchBar());

    // How the listing reports a page change: no next page yet, the old range.
    rerender(searchBar({ paging: firstPage({ hasNext: false, changing: true }) }));

    expect(screen.getByText('100+ items')).toBeInTheDocument();
  });

  it('counts the new listing once it arrives', () => {
    const { rerender } = render(searchBar());
    rerender(searchBar({ paging: firstPage({ hasNext: false, changing: true }) }));

    rerender(searchBar({ paging: firstPage({ rangeStart: 101, rangeEnd: 150, hasNext: false }) }));

    expect(screen.getByText('150 items')).toBeInTheDocument();
  });

  it('holds the newest count, not the first, through a second page change', () => {
    const { rerender } = render(searchBar());
    rerender(searchBar({ paging: firstPage({ hasNext: false, changing: true }) }));
    const secondPage = firstPage({ rangeStart: 101, rangeEnd: 200, hasPrevious: true });
    rerender(searchBar({ paging: secondPage }));

    rerender(searchBar({ paging: { ...secondPage, hasNext: false, changing: true } }));

    expect(screen.getByText('200+ items')).toBeInTheDocument();
  });

  it('counts items while the typed search has not been listed yet', () => {
    render(searchBar({ search: 'any-search', listedSearch: '' }));

    expect(screen.getByText('100+ items')).toBeInTheDocument();
  });

  it('counts matches once the rows answer a search', () => {
    render(
      searchBar({
        search: 'any-search',
        listedSearch: 'any-search',
        paging: undefined,
        rowCount: 3,
      }),
    );

    expect(screen.getByText('3 matches')).toBeInTheDocument();
  });

  it('leaves the count out when the listing fails while a page loads', () => {
    const { rerender } = render(searchBar());

    rerender(searchBar({ rowCount: undefined, paging: firstPage({ changing: true }) }));

    expect(screen.queryByText(/items|matches/)).not.toBeInTheDocument();
  });
});
