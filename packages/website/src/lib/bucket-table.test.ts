import { describe, it, expect } from 'vitest';

import type { Bucket } from '@filone/shared';
import {
  ALL_REGIONS,
  BUCKET_TABLE_CONTROLS_MIN,
  DEFAULT_BUCKET_SORT,
  EMPTY_BUCKET_FILTERS,
  bucketRegions,
  bucketsQueryParams,
  hasActiveFilters,
  hasRefinements,
  nextBucketSort,
  shouldShowBucketControls,
} from './bucket-table.js';

function bucket(overrides: Partial<Bucket> & { bucketName: string }): Bucket {
  return {
    region: 'eu-west-1',
    createdAt: '2026-01-01T00:00:00Z',
    isPublic: false,
    ...overrides,
  };
}

const BUCKETS: Bucket[] = [
  bucket({ bucketName: 'archive', region: 'us-east-1', createdAt: '2026-03-01T00:00:00Z' }),
  bucket({ bucketName: 'media', region: 'eu-west-1', createdAt: '2026-01-15T00:00:00Z' }),
  bucket({ bucketName: 'Uploads', region: 'eu-central-3', createdAt: '2026-02-10T00:00:00Z' }),
];

// ---------------------------------------------------------------------------
// shouldShowBucketControls
// ---------------------------------------------------------------------------

describe('shouldShowBucketControls', () => {
  it('shows the controls at exactly the minimum, not one past it', () => {
    expect(shouldShowBucketControls(BUCKET_TABLE_CONTROLS_MIN)).toBe(true);
    expect(shouldShowBucketControls(BUCKET_TABLE_CONTROLS_MIN - 1)).toBe(false);
  });

  it('shows the controls for longer lists', () => {
    expect(shouldShowBucketControls(BUCKET_TABLE_CONTROLS_MIN + 20)).toBe(true);
  });

  it('hides them for an empty or single-bucket list', () => {
    expect(shouldShowBucketControls(0)).toBe(false);
    expect(shouldShowBucketControls(1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bucketRegions
// ---------------------------------------------------------------------------

describe('bucketRegions', () => {
  it('returns distinct regions ordered by label', () => {
    // Amsterdam, France, US East
    expect(bucketRegions(BUCKETS)).toEqual(['eu-central-3', 'eu-west-1', 'us-east-1']);
  });

  it('collapses duplicates so a single-region account gets one entry', () => {
    const single = [bucket({ bucketName: 'a' }), bucket({ bucketName: 'b' })];
    expect(bucketRegions(single)).toEqual(['eu-west-1']);
  });

  it('falls back to the default region when the API omits it', () => {
    const noRegion = [{ ...bucket({ bucketName: 'a' }), region: undefined }] as unknown as Bucket[];
    expect(bucketRegions(noRegion)).toEqual(['eu-west-1']);
  });
});

// ---------------------------------------------------------------------------
// hasActiveFilters / hasRefinements
// ---------------------------------------------------------------------------

describe('hasActiveFilters', () => {
  it('is false for the empty filters', () => {
    expect(hasActiveFilters(EMPTY_BUCKET_FILTERS)).toBe(false);
  });

  it('is true for a non-empty query', () => {
    expect(hasActiveFilters({ query: 'media', region: ALL_REGIONS })).toBe(true);
  });

  it('is true for a region other than "all"', () => {
    expect(hasActiveFilters({ query: '', region: 'eu-west-1' })).toBe(true);
  });
});

describe('hasRefinements', () => {
  it('is false with default filters and default sort', () => {
    expect(hasRefinements(EMPTY_BUCKET_FILTERS, DEFAULT_BUCKET_SORT)).toBe(false);
  });

  it('is true when a filter is active, even with the default sort', () => {
    expect(hasRefinements({ query: 'media', region: ALL_REGIONS }, DEFAULT_BUCKET_SORT)).toBe(true);
  });

  it('is true when the sort is non-default, even with no active filters', () => {
    expect(hasRefinements(EMPTY_BUCKET_FILTERS, { key: 'createdAt', direction: 'asc' })).toBe(true);
    expect(hasRefinements(EMPTY_BUCKET_FILTERS, { key: 'bucketName', direction: 'desc' })).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// bucketsQueryParams
// ---------------------------------------------------------------------------

describe('bucketsQueryParams', () => {
  it('is empty for default filters and sort', () => {
    expect(bucketsQueryParams(EMPTY_BUCKET_FILTERS, DEFAULT_BUCKET_SORT).toString()).toBe('');
  });

  it('trims and forwards a non-empty search', () => {
    const params = bucketsQueryParams(
      { query: '  media  ', region: ALL_REGIONS },
      DEFAULT_BUCKET_SORT,
    );
    expect(params.get('search')).toBe('media');
  });

  it('omits search entirely for a blank query', () => {
    const params = bucketsQueryParams({ query: '   ', region: ALL_REGIONS }, DEFAULT_BUCKET_SORT);
    expect(params.has('search')).toBe(false);
  });

  it('forwards a region other than "all"', () => {
    const params = bucketsQueryParams({ query: '', region: 'us-east-1' }, DEFAULT_BUCKET_SORT);
    expect(params.get('region')).toBe('us-east-1');
  });

  it('forwards a non-default sort key and direction', () => {
    const params = bucketsQueryParams(EMPTY_BUCKET_FILTERS, {
      key: 'createdAt',
      direction: 'desc',
    });
    expect(params.get('sortKey')).toBe('createdAt');
    expect(params.get('sortDirection')).toBe('desc');
  });

  it('omits sortDirection when only the key changed to a non-default one at the default direction', () => {
    const params = bucketsQueryParams(EMPTY_BUCKET_FILTERS, { key: 'region', direction: 'asc' });
    expect(params.get('sortKey')).toBe('region');
    expect(params.has('sortDirection')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextBucketSort
// ---------------------------------------------------------------------------

describe('nextBucketSort', () => {
  it('starts a newly clicked column ascending', () => {
    expect(nextBucketSort({ key: 'bucketName', direction: 'desc' }, 'createdAt')).toEqual({
      key: 'createdAt',
      direction: 'asc',
    });
  });

  it('toggles direction on the active column', () => {
    const asc = { key: 'createdAt', direction: 'asc' } as const;
    expect(nextBucketSort(asc, 'createdAt')).toEqual({ key: 'createdAt', direction: 'desc' });
    expect(nextBucketSort({ key: 'createdAt', direction: 'desc' }, 'createdAt')).toEqual(asc);
  });
});
