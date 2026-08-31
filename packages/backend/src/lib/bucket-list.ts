// Filtering and sorting for GET /buckets (FIL-324: moved off the frontend so a
// tenant with many buckets isn't shipping and re-sorting the full list on every
// keystroke). Kept as pure functions, mirroring the shape the old client-side
// `lib/bucket-table.ts` used, so behaviour didn't change in the move.

import type { BucketSortKey, SortDirection } from '@filone/shared';
import { getRegionLabel } from '@filone/shared';
import type { BucketSummary } from './service-orchestrator.js';

export function filterBucketsByName(buckets: BucketSummary[], search: string): BucketSummary[] {
  const query = search.trim().toLowerCase();
  if (query === '') return buckets;
  return buckets.filter((bucket) => bucket.bucketName.toLowerCase().includes(query));
}

function compare(a: BucketSummary, b: BucketSummary, key: BucketSortKey): number {
  if (key === 'createdAt') {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  }
  if (key === 'region') {
    // Sort by what the row displays (the label), then by code so buckets
    // sharing a label keep a deterministic order.
    const byLabel = getRegionLabel(a.region).localeCompare(getRegionLabel(b.region));
    return byLabel !== 0 ? byLabel : a.region.localeCompare(b.region);
  }
  return a.bucketName.localeCompare(b.bucketName);
}

export function sortBuckets(
  buckets: BucketSummary[],
  sortKey: BucketSortKey,
  sortDirection: SortDirection,
): BucketSummary[] {
  const direction = sortDirection === 'asc' ? 1 : -1;
  // Negating the comparator rather than reversing the result keeps the sort
  // stable in both directions, so tied rows (e.g. two buckets created the same
  // second) hold their relative order instead of flipping.
  return [...buckets].sort((a, b) => direction * compare(a, b, sortKey));
}
