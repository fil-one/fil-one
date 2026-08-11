// Filtering and sorting for the buckets table. Kept as pure functions so the
// page component stays presentational and the ordering rules can be tested
// without rendering.

import type { Bucket } from '@filone/shared';
import { S3_REGION, getRegionLabel } from '@filone/shared';

/**
 * Bucket count at which the table starts showing its search, sort and filter
 * controls. Below this the whole list is one glance and the controls are chrome.
 */
export const BUCKET_TABLE_CONTROLS_MIN = 5;

/** True when a list is long enough to be worth searching, sorting and filtering. */
export function shouldShowBucketControls(bucketCount: number): boolean {
  return bucketCount >= BUCKET_TABLE_CONTROLS_MIN;
}

export type BucketSortKey = 'bucketName' | 'region' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

export type BucketSort = {
  key: BucketSortKey;
  direction: SortDirection;
};

/** Matches the order `list-buckets` returns, so the initial render is stable. */
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

export function filterBuckets(buckets: Bucket[], filters: BucketFilters): Bucket[] {
  const query = filters.query.trim().toLowerCase();
  return buckets.filter((bucket) => {
    const matchesQuery = query === '' || bucket.bucketName.toLowerCase().includes(query);
    const matchesRegion = filters.region === ALL_REGIONS || regionOf(bucket) === filters.region;
    return matchesQuery && matchesRegion;
  });
}

function compare(a: Bucket, b: Bucket, key: BucketSortKey): number {
  if (key === 'createdAt') {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  }
  if (key === 'region') {
    // Sort by what the row actually displays (the label), then by code so
    // buckets sharing a label keep a deterministic order.
    const byLabel = getRegionLabel(regionOf(a)).localeCompare(getRegionLabel(regionOf(b)));
    return byLabel !== 0 ? byLabel : regionOf(a).localeCompare(regionOf(b));
  }
  return a.bucketName.localeCompare(b.bucketName);
}

export function sortBuckets(buckets: Bucket[], sort: BucketSort): Bucket[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  // Negating the comparator rather than reversing the result keeps the sort
  // stable in both directions, so tied rows (e.g. two buckets created the same
  // second) hold their relative order instead of flipping.
  return [...buckets].sort((a, b) => direction * compare(a, b, sort.key));
}

/**
 * Sort state after clicking `key`: a new column starts ascending, and clicking
 * the active column toggles direction.
 */
export function nextBucketSort(current: BucketSort, key: BucketSortKey): BucketSort {
  if (current.key !== key) return { key, direction: 'asc' };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}
