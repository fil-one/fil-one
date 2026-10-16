import type { AccessKey } from '@filone/shared';
import { getRegionLabel } from '@filone/shared';

import { SearchInput } from './SearchInput';
import { Select } from './Select';
import { ALL, type AccessKeyFilters, hasActiveAccessKeyFilters } from '../lib/access-key-table.js';

type AccessKeysToolbarProps = {
  filters: AccessKeyFilters;
  onChange: (filters: AccessKeyFilters) => void;
  /** Every key loaded, unfiltered: each filter shows only when it can split them. */
  keys: AccessKey[];
  /** Regions present in the loaded keys. */
  regions: string[];
  /** Rows matching the current filters, for the result count. */
  matchCount: number;
};

/**
 * Search and filters for the API keys table, built like the buckets table's
 * toolbar so the two pages read as one product: 32px controls, 13px text, and a
 * count that turns into a fraction once the filters narrow something. A filter
 * whose every option would keep the same keys is left out.
 */
export function AccessKeysToolbar({
  filters,
  onChange,
  keys,
  regions,
  matchCount,
}: AccessKeysToolbarProps) {
  const showRegionFilter = regions.length > 1;
  const showStatusFilter = keys.some((key) => key.status === 'expired');
  const showTypeFilter = keys.some((key) => key.type === 'principal');
  const filtering = hasActiveAccessKeyFilters(filters);

  return (
    // Wraps rather than squeezes: at 375px the search takes the full width and
    // the filters and count drop to a second line.
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <SearchInput
        value={filters.query}
        onChange={(query) => onChange({ ...filters, query })}
        placeholder="Search keys"
        aria-label="Search keys by name or access key ID"
        className="w-full sm:w-64"
      />

      {showRegionFilter && (
        <Select
          value={filters.region}
          onChange={(region) => onChange({ ...filters, region })}
          aria-label="Filter keys by region"
          selectSize="sm"
          className="w-auto"
        >
          <option value={ALL}>All regions</option>
          {regions.map((region) => (
            <option key={region} value={region}>
              {getRegionLabel(region)}
            </option>
          ))}
        </Select>
      )}

      {showStatusFilter && (
        <Select
          value={filters.status}
          onChange={(status) => onChange({ ...filters, status: toStatusFilter(status) })}
          aria-label="Filter keys by status"
          selectSize="sm"
          className="w-auto"
        >
          <option value={ALL}>All statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
        </Select>
      )}

      {showTypeFilter && (
        <Select
          value={filters.type}
          onChange={(type) => onChange({ ...filters, type: toTypeFilter(type) })}
          aria-label="Filter keys by type"
          selectSize="sm"
          className="w-auto"
        >
          <option value={ALL}>All types</option>
          <option value="service">Service</option>
          <option value="principal">Personal</option>
        </Select>
      )}

      {/* Reads as a total until the filters narrow it, then as a fraction, so the
          number always answers "how much am I looking at". */}
      <p className="ml-auto text-xs text-zinc-500 tabular-nums" aria-live="polite">
        {filtering
          ? `${matchCount} of ${keys.length}`
          : `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`}
      </p>
    </div>
  );
}

// A select hands back a plain string; these map it onto the filter's own values,
// with anything unexpected meaning "keep every key".
function toStatusFilter(value: string): AccessKeyFilters['status'] {
  return value === 'active' || value === 'expired' ? value : ALL;
}

function toTypeFilter(value: string): AccessKeyFilters['type'] {
  return value === 'service' || value === 'principal' ? value : ALL;
}
