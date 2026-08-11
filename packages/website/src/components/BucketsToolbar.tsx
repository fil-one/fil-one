import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/ssr';

import { getRegionLabel } from '@filone/shared';

import { Input } from './Input';
import { Select } from './Select';
import { ALL_REGIONS, type BucketFilters } from '../lib/bucket-table.js';

type BucketsToolbarProps = {
  filters: BucketFilters;
  onChange: (filters: BucketFilters) => void;
  /** Regions present in the loaded buckets. The filter is hidden below two. */
  regions: string[];
  /** Rows matching the current filters, for the result count. */
  matchCount: number;
  totalCount: number;
};

export function BucketsToolbar({
  filters,
  onChange,
  regions,
  matchCount,
  totalCount,
}: BucketsToolbarProps) {
  const showRegionFilter = regions.length > 1;

  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative sm:max-w-xs sm:flex-1">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400">
          <MagnifyingGlassIcon size={15} />
        </span>
        <Input
          type="search"
          value={filters.query}
          onChange={(query) => onChange({ ...filters, query })}
          placeholder="Search buckets"
          aria-label="Search buckets by name"
          className="py-2 pl-9"
        />
      </div>

      {showRegionFilter && (
        <div className="sm:w-56">
          <Select
            value={filters.region}
            onChange={(region) => onChange({ ...filters, region })}
            aria-label="Filter buckets by region"
            className="py-2"
          >
            <option value={ALL_REGIONS}>All regions</option>
            {regions.map((region) => (
              <option key={region} value={region}>
                {getRegionLabel(region)}
              </option>
            ))}
          </Select>
        </div>
      )}

      <p className="text-xs text-zinc-500 sm:ml-auto" aria-live="polite">
        {matchCount === totalCount
          ? `${totalCount} ${totalCount === 1 ? 'bucket' : 'buckets'}`
          : `${matchCount} of ${totalCount} buckets`}
      </p>
    </div>
  );
}
