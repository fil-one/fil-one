import { useEffect, useState } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';

import type { S3Region } from '@filone/shared';

import { getEntriesAtPrefix, groupVersionsByKey } from './object-grouping.js';
import type { ListingCursor, ObjectListingPage } from './object-listing.js';
import { fetchObjectListingPage } from './object-listing.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys } from './query-client.js';

/** A page the reader has reached: where S3 resumes for it, and how many rows came before it. */
interface VisitedPage {
  cursor?: ListingCursor;
  offset: number;
}

const FIRST_PAGE: VisitedPage[] = [{ offset: 0 }];

/**
 * The pages visited in one folder, and the offset of the page that was on
 * screen when the reader last moved. That page stays on screen until the new
 * one arrives, so the range label counts from its offset meanwhile.
 */
interface PagingState {
  prefix: string;
  search: string;
  pages: VisitedPage[];
  leftOffset: number;
}

interface ObjectListingOptions {
  bucketName: string;
  region: S3Region;
  versioning: boolean;
  /** The folder being browsed, ending in '/', or '' for the bucket's root. */
  prefix: string;
  /**
   * The start of a name to narrow the folder to. S3 matches it as part of the
   * listed prefix, so the search covers every page of the folder, not only the
   * one on screen, and is case-sensitive like the keys themselves.
   */
  search: string;
  enabled: boolean;
}

function getPageQueryOptions(
  { bucketName, region, versioning, prefix, search }: Omit<ObjectListingOptions, 'enabled'>,
  cursor: ListingCursor | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.objectsPage({ bucketName, region, prefix, search, cursor: cursor ?? null }),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () =>
      fetchObjectListingPage({
        region,
        bucketName,
        versioning,
        prefix: `${prefix}${search}`,
        cursor,
      }),
  });
}

/** The rows a page renders, which is what the range label counts. */
function countRows(page: ObjectListingPage, prefix: string): number {
  return getEntriesAtPrefix(groupVersionsByKey(page.versions), page.folders, prefix).length;
}

/**
 * One folder of a bucket, a page at a time, moved through with previous and next.
 *
 * S3 hands out a token for the next page only and never a total, so the pages
 * the reader has passed through are kept as a stack: Previous pops it, Next
 * pushes the page's cursor. Opening another folder, or searching, starts from
 * the first page of what is now listed.
 *
 * Each page is its own cached query, so going back repaints at once, and the
 * page after the current one is fetched ahead so Next does not wait either.
 */
export function useObjectListing({
  bucketName,
  region,
  versioning,
  prefix,
  search,
  enabled,
}: ObjectListingOptions) {
  const queryClient = useQueryClient();
  const listing = { bucketName, region, versioning, prefix, search };
  const [paging, setPaging] = useState<PagingState>({
    prefix,
    search,
    pages: FIRST_PAGE,
    leftOffset: 0,
  });
  // Derived rather than reset in an effect, so a new folder or search never
  // renders one frame of the previous listing's page position.
  const pages = paging.prefix === prefix && paging.search === search ? paging.pages : FIRST_PAGE;
  const current = pages[pages.length - 1];

  const query = useQuery({
    ...getPageQueryOptions(listing, current.cursor),
    enabled,
    // Holds the page on screen while the next one loads, so the table keeps
    // its place instead of dropping to a skeleton, through page changes and
    // each keystroke of a search. Only within one folder: another folder's rows
    // under this folder's breadcrumb would be wrong.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === prefix ? previous : undefined,
  });

  // The search the rows on screen answered. It trails `search` while a held
  // page stands in for the new search's, so an empty state can describe the
  // rows it sits over rather than a listing that has not arrived. Updated
  // during render, React's pattern for state derived from a previous render,
  // so it never lags the rows by a frame.
  const [listedSearch, setListedSearch] = useState(search);
  if (query.data && !query.isPlaceholderData && listedSearch !== search) {
    setListedSearch(search);
  }

  const page = query.data;
  const nextCursor = query.isPlaceholderData ? undefined : page?.nextCursor;

  useEffect(() => {
    if (!enabled || !nextCursor) return;
    void queryClient.prefetchQuery(
      getPageQueryOptions({ bucketName, region, versioning, prefix, search }, nextCursor),
    );
  }, [queryClient, enabled, nextCursor, bucketName, region, versioning, prefix, search]);

  const rowCount = page ? countRows(page, prefix) : 0;
  // While the next page loads the table still shows the page the reader left,
  // so the label describes that page rather than the one on its way.
  const shownOffset = query.isPlaceholderData ? paging.leftOffset : current.offset;

  return {
    query,
    page,
    /** The search the page's rows answered, which trails `search` until its listing arrives. */
    listedSearch,
    /** One-based position of the page's first row, for the range label. */
    rangeStart: shownOffset + 1,
    rangeEnd: shownOffset + rowCount,
    hasPrevious: pages.length > 1,
    hasNext: nextCursor !== undefined,
    isFirstPage: pages.length === 1,
    /** True while a page change waits on S3, with the previous page still shown. */
    isChangingPage: query.isPlaceholderData,
    goToNextPage: () => {
      if (!nextCursor) return;
      setPaging({
        prefix,
        search,
        pages: [...pages, { cursor: nextCursor, offset: current.offset + rowCount }],
        leftOffset: current.offset,
      });
    },
    goToPreviousPage: () => {
      if (pages.length > 1) {
        setPaging({ prefix, search, pages: pages.slice(0, -1), leftOffset: current.offset });
      }
    },
  };
}
