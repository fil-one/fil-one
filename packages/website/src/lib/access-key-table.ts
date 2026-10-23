// Access-key-table filter state and helpers. Unlike the buckets table, which
// filters on the backend, the API keys page already holds every key the caller
// may see, so the narrowing happens here in the browser.

import type { AccessKey, AccessKeyStatus } from '@filone/shared';
import { S3_REGION, getRegionLabel } from '@filone/shared';

/**
 * Key count at which the table starts showing its search and filters. The same
 * threshold as the buckets table: below it the whole list is one glance.
 */
export const ACCESS_KEY_TABLE_CONTROLS_MIN = 5;

/** True when a list is long enough to be worth searching and filtering. */
export function shouldShowAccessKeyControls(keyCount: number): boolean {
  return keyCount >= ACCESS_KEY_TABLE_CONTROLS_MIN;
}

/** The value a filter holds when it keeps every key. */
export const ALL = 'all';

export type AccessKeyFilters = {
  /** Free-text match against the key name and access key ID. */
  query: string;
  /** Region code to keep, or {@link ALL}. */
  region: string;
  status: AccessKeyStatus | typeof ALL;
  type: AccessKey['type'] | typeof ALL;
};

export const EMPTY_ACCESS_KEY_FILTERS: AccessKeyFilters = {
  query: '',
  region: ALL,
  status: ALL,
  type: ALL,
};

/** True when the filters narrow the list, which is when the count reads as a fraction. */
export function hasActiveAccessKeyFilters(filters: AccessKeyFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.region !== ALL ||
    filters.status !== ALL ||
    filters.type !== ALL
  );
}

/** A key's region, falling back to the default when the API omits it. */
function regionOf(key: AccessKey): string {
  return key.region ?? S3_REGION;
}

/** The keys the filters keep, in the order they came in. */
export function filterAccessKeys(keys: AccessKey[], filters: AccessKeyFilters): AccessKey[] {
  const query = filters.query.trim().toLowerCase();
  return keys.filter(
    (key) =>
      (query === '' ||
        key.keyName.toLowerCase().includes(query) ||
        key.accessKeyId.toLowerCase().includes(query)) &&
      (filters.region === ALL || regionOf(key) === filters.region) &&
      (filters.status === ALL || key.status === filters.status) &&
      (filters.type === ALL || key.type === filters.type),
  );
}

/**
 * Distinct regions present in `keys`, ordered by their human-readable label.
 * The region filter is only worth showing when this returns more than one.
 */
export function accessKeyRegions(keys: AccessKey[]): string[] {
  const regions = [...new Set(keys.map(regionOf))];
  return regions.sort((a, b) => getRegionLabel(a).localeCompare(getRegionLabel(b)));
}

/**
 * Which filters can split these keys, so are worth showing: region with keys in
 * more than one, status once one has expired, type once a personal key exists.
 */
export function getVisibleAccessKeyFilters(keys: AccessKey[]): {
  region: boolean;
  status: boolean;
  type: boolean;
} {
  return {
    region: accessKeyRegions(keys).length > 1,
    status: keys.some((key) => key.status === 'expired'),
    type: keys.some((key) => key.type === 'principal'),
  };
}

/**
 * The filters with any hidden one reset to keep every key. A filter hides once
 * it cannot split the list (the last expired key deleted, say), and left set
 * it would go on narrowing the list with no control on screen to clear it.
 */
export function clearHiddenAccessKeyFilters(
  keys: AccessKey[],
  filters: AccessKeyFilters,
): AccessKeyFilters {
  const visible = getVisibleAccessKeyFilters(keys);
  return {
    query: filters.query,
    region: visible.region ? filters.region : ALL,
    status: visible.status ? filters.status : ALL,
    type: visible.type ? filters.type : ALL,
  };
}
