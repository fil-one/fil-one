// Bucket-table filter/sort state and helpers. The actual filtering and sorting
// happen on the backend now (FIL-324): a tenant with many buckets shouldn't ship
// its full list to the browser just to narrow it down there. This module only
// holds the UI state shapes, the query-params they map to, and the controls
// visibility rule.

import type { Bucket, BucketSortKey, SortDirection } from '@filone/shared';
import { S3_REGION, getRegionLabel } from '@filone/shared';

export type { BucketSortKey, SortDirection };

/**
 * Bucket count at which the table starts showing its search, sort and filter
 * controls. Below this the whole list is one glance and the controls are chrome.
 */
export const BUCKET_TABLE_CONTROLS_MIN = 5;

/** True when a list is long enough to be worth searching, sorting and filtering. */
export function shouldShowBucketControls(bucketCount: number): boolean {
  return bucketCount >= BUCKET_TABLE_CONTROLS_MIN;
}

export type BucketSort = {
  key: BucketSortKey;
  direction: SortDirection;
};

/** Matches the order `list-buckets` returns by default, so the initial render is stable. */
export const DEFAULT_BUCKET_SORT: BucketSort = { key: 'bucketName', direction: 'asc' };

export type BucketFilters = {
  /** Free-text match against the bucket name. */
  query: string;
  /** Region code to keep, or 'all' for every region. */
  region: string;
};

export const ALL_REGIONS = 'all';

export const EMPTY_BUCKET_FILTERS: BucketFilters = { query: '', region: ALL_REGIONS };

/**
 * True when the filters actually narrow the list. Drives the result count, which
 * says nothing when every bucket is showing.
 */
export function hasActiveFilters(filters: BucketFilters): boolean {
  return filters.query.trim() !== '' || filters.region !== ALL_REGIONS;
}

/** True when either filters or sort deviate from what the unfiltered baseline already shows. */
export function hasRefinements(filters: BucketFilters, sort: BucketSort): boolean {
  return (
    hasActiveFilters(filters) ||
    sort.key !== DEFAULT_BUCKET_SORT.key ||
    sort.direction !== DEFAULT_BUCKET_SORT.direction
  );
}

/** A bucket's region, falling back to the default when the API omits it. */
function regionOf(bucket: Bucket): string {
  return bucket.region ?? S3_REGION;
}

/**
 * Distinct regions present in `buckets`, ordered by their human-readable label.
 * The region filter is only worth showing when this returns more than one.
 */
export function bucketRegions(buckets: Bucket[]): string[] {
  const regions = [...new Set(buckets.map(regionOf))];
  return regions.sort((a, b) => getRegionLabel(a).localeCompare(getRegionLabel(b)));
}

/** Query-string params `/buckets` accepts, built from the current UI state. */
export function bucketsQueryParams(filters: BucketFilters, sort: BucketSort): URLSearchParams {
  const params = new URLSearchParams();
  const query = filters.query.trim();
  if (query !== '') params.set('search', query);
  if (filters.region !== ALL_REGIONS) params.set('region', filters.region);
  if (sort.key !== DEFAULT_BUCKET_SORT.key) params.set('sortKey', sort.key);
  if (sort.direction !== DEFAULT_BUCKET_SORT.direction) params.set('sortDirection', sort.direction);
  return params;
}

/**
 * Sort state after clicking `key`: a new column starts ascending, and clicking
 * the active column toggles direction.
 */
export function nextBucketSort(current: BucketSort, key: BucketSortKey): BucketSort {
  if (current.key !== key) return { key, direction: 'asc' };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}
