import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from './Button';
import { EmptyStateCard } from './EmptyStateCard';
import { SearchInput } from './SearchInput';

/**
 * Stands in for the table when it has no rows: a search that matched nothing
 * offers to clear it, and an empty folder says so.
 */
export function NoObjectsShown({
  searching,
  inFolder,
  onClearSearch,
}: {
  searching: boolean;
  inFolder: boolean;
  onClearSearch: () => void;
}) {
  if (!searching) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
        <p className="text-sm text-zinc-500">No objects at this path</p>
      </div>
    );
  }

  return (
    <EmptyStateCard
      icon={MagnifyingGlassIcon}
      iconColor="grey"
      title="No matching objects"
      description={`No object ${inFolder ? 'in this folder ' : ''}matches your search.`}
    >
      <Button id="object-browser-clear-search-button" variant="ghost" onClick={onClearSearch}>
        Clear search
      </Button>
    </EmptyStateCard>
  );
}

type ObjectsToolbarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  /** True inside a folder, where the search covers only that folder and below. */
  inFolder: boolean;
  /** Objects matching the search, for the result count. */
  matchCount: number;
  /** Objects under the open folder, nested ones included. */
  totalCount: number;
};

/**
 * Search chrome for the object table, built like `BucketsToolbar`: 32px controls
 * and a count that reads as a total until the search narrows it, then as a
 * fraction. Sorting lives on the column heads.
 */
export function ObjectsToolbar({
  query,
  onQueryChange,
  inFolder,
  matchCount,
  totalCount,
}: ObjectsToolbarProps) {
  const searching = query.trim() !== '';

  return (
    // Wraps rather than squeezes: at 375px the search takes the full width and
    // the count drops to a second line.
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <SearchInput
        value={query}
        onChange={onQueryChange}
        placeholder={inFolder ? 'Search this folder' : 'Search objects'}
        aria-label={inFolder ? 'Search objects in this folder by name' : 'Search objects by name'}
        className="w-full sm:w-64"
      />

      <p className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
        {searching
          ? `${matchCount.toLocaleString()} of ${totalCount.toLocaleString()}`
          : `${totalCount.toLocaleString()} ${totalCount === 1 ? 'object' : 'objects'}`}
      </p>
    </div>
  );
}
