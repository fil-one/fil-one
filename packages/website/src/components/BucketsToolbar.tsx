import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/ssr';

import { getRegionLabel } from '@filone/shared';

import { Input } from './Input';
import { Select } from './Select';
import { ALL_REGIONS, type BucketFilters, hasActiveFilters } from '../lib/bucket-table.js';

type BucketsToolbarProps = {
  filters: BucketFilters;
  onChange: (filters: BucketFilters) => void;
  /** Regions present in the loaded buckets. The filter is hidden below two. */
  regions: string[];
  /** Rows matching the current filters, for the result count. */
  matchCount: number;
  totalCount: number;
};

/**
 * Filter chrome for the buckets table, deliberately quieter and shorter than the
 * form controls it borrows: at the default 40px height with full borders, three
 * of these read as a form floating above the table rather than as controls
 * belonging to it. 32px, 13px text, and no result count until the filters
 * actually narrow something.
 */
export function BucketsToolbar({
  filters,
  onChange,
  regions,
  matchCount,
  totalCount,
}: BucketsToolbarProps) {
  const showRegionFilter = regions.length > 1;
  const filtering = hasActiveFilters(filters);

  return (
    // Wraps rather than squeezes: at 375px the search takes the full width and
    // the filter and count drop to a second line.
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-400">
          <MagnifyingGlassIcon size={14} />
        </span>
        <Input
          type="search"
          value={filters.query}
          onChange={(query) => onChange({ ...filters, query })}
          placeholder="Search buckets"
          aria-label="Search buckets by name"
          inputSize="sm"
          className="pl-8"
        />
      </div>

      {showRegionFilter && (
        <Select
          value={filters.region}
          onChange={(region) => onChange({ ...filters, region })}
          aria-label="Filter buckets by region"
          selectSize="sm"
          className="w-auto"
        >
          <option value={ALL_REGIONS}>All regions</option>
          {regions.map((region) => (
            <option key={region} value={region}>
              {getRegionLabel(region)}
            </option>
          ))}
        </Select>
      )}

      {/* Reads as a total until the filters narrow it, then as a fraction, so the
          number always answers "how much am I looking at". */}
      <p className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
        {filtering
          ? `${matchCount} of ${totalCount}`
          : `${totalCount} ${totalCount === 1 ? 'bucket' : 'buckets'}`}
      </p>
    </div>
  );
}
