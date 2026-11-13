import type { ListingPagerProps } from './ListingPager';
import { SearchInput } from './SearchInput';

export function PrefixBreadcrumb({
  bucketName,
  currentPrefix,
  onPrefixChange,
}: {
  bucketName: string;
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
}) {
  const segments = currentPrefix.split('/').filter(Boolean);
  const crumbs = [
    { label: bucketName, prefix: '' },
    ...segments.map((segment, idx) => ({
      label: segment,
      prefix: segments.slice(0, idx + 1).join('/') + '/',
    })),
  ];

  // Styled as the page's own `Breadcrumb`: a crumb that leads somewhere is muted
  // and darkens on hover, the folder you are in is near-black, and nothing takes
  // the accent colour. Buttons rather than links, since a folder is a search
  // param on this page and changing it replaces the history entry.
  return (
    <nav aria-label="Folder" className="mb-4">
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {crumbs.map((crumb, idx) => {
          const isLast = idx === crumbs.length - 1;
          return (
            <li key={crumb.prefix} className="flex min-w-0 items-center gap-2">
              {idx > 0 && (
                <span aria-hidden="true" className="text-zinc-400 select-none">
                  /
                </span>
              )}
              {isLast ? (
                <span className="truncate font-medium text-zinc-950" aria-current="location">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onPrefixChange(crumb.prefix)}
                  className="truncate rounded-md text-zinc-500 transition-colors duration-150 hover:text-zinc-950 focus-visible:brand-outline"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * How many rows the listing has reached, for the toolbar. S3 gives no total for
 * a folder, so while more pages remain the count is a floor ("100+"), and it
 * becomes exact on the last page, once every row has been seen.
 */
export function describeListingCount({
  reached,
  hasMore,
  searching,
}: {
  reached: number;
  hasMore: boolean;
  searching: boolean;
}): string {
  const singular = reached === 1 && !hasMore;
  const noun = searching ? (singular ? 'match' : 'matches') : singular ? 'item' : 'items';
  return `${reached.toLocaleString()}${hasMore ? '+' : ''} ${noun}`;
}

/** Narrows the listing to names that start with what is typed, beside its count. */
export function ObjectSearchBar({
  search,
  place,
  onSearchChange,
  paging,
  rowCount,
}: {
  search: string;
  place: 'folder' | 'bucket';
  onSearchChange: (search: string) => void;
  paging?: Omit<ListingPagerProps, 'label'>;
  /** Rows on this page, the count when the listing is not paged. */
  rowCount: number;
}) {
  const count = describeListingCount({
    reached: paging ? paging.rangeEnd : rowCount,
    hasMore: paging?.hasNext ?? false,
    searching: search !== '',
  });
  return (
    // Wraps rather than squeezes, like the other list toolbars: at 375px the
    // search takes the full width.
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <SearchInput
        value={search}
        onChange={onSearchChange}
        // Says how it matches: S3 finds names by their start, not by any part
        // of them, and "Search objects" would promise the latter.
        placeholder="Name starts with…"
        aria-label={`Find objects in this ${place} by the start of their name`}
        className="w-full sm:w-64"
      />
      {/* Matches the buckets toolbar, which keeps its count at the row's end. */}
      <p className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
        {count}
      </p>
    </div>
  );
}
