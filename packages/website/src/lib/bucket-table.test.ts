import { describe, it, expect } from 'vitest';

import type { Bucket } from '@filone/shared';
import {
  ALL_REGIONS,
  DEFAULT_BUCKET_SORT,
  EMPTY_BUCKET_FILTERS,
  bucketRegions,
  filterBuckets,
  nextBucketSort,
  sortBuckets,
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
// filterBuckets
// ---------------------------------------------------------------------------

describe('filterBuckets', () => {
  it('returns everything with empty filters', () => {
    expect(filterBuckets(BUCKETS, EMPTY_BUCKET_FILTERS)).toHaveLength(3);
  });

  it('matches the name case-insensitively on a substring', () => {
    const result = filterBuckets(BUCKETS, { query: 'LOAD', region: ALL_REGIONS });
    expect(result.map((b) => b.bucketName)).toEqual(['Uploads']);
  });

  it('ignores surrounding whitespace in the query', () => {
    const result = filterBuckets(BUCKETS, { query: '  media  ', region: ALL_REGIONS });
    expect(result.map((b) => b.bucketName)).toEqual(['media']);
  });

  it('filters by region', () => {
    const result = filterBuckets(BUCKETS, { query: '', region: 'us-east-1' });
    expect(result.map((b) => b.bucketName)).toEqual(['archive']);
  });

  it('applies query and region together', () => {
    // 'a' alone matches all three; the region narrows it to the one in France.
    const result = filterBuckets(BUCKETS, { query: 'a', region: 'eu-west-1' });
    expect(result.map((b) => b.bucketName)).toEqual(['media']);
  });

  it('returns nothing when the query and region disagree', () => {
    expect(filterBuckets(BUCKETS, { query: 'media', region: 'us-east-1' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sortBuckets
// ---------------------------------------------------------------------------

describe('sortBuckets', () => {
  it('sorts by name ascending, ignoring case', () => {
    const result = sortBuckets(BUCKETS, DEFAULT_BUCKET_SORT);
    expect(result.map((b) => b.bucketName)).toEqual(['archive', 'media', 'Uploads']);
  });

  it('sorts by name descending', () => {
    const result = sortBuckets(BUCKETS, { key: 'bucketName', direction: 'desc' });
    expect(result.map((b) => b.bucketName)).toEqual(['Uploads', 'media', 'archive']);
  });

  it('sorts by creation date, oldest first when ascending', () => {
    const result = sortBuckets(BUCKETS, { key: 'createdAt', direction: 'asc' });
    expect(result.map((b) => b.bucketName)).toEqual(['media', 'Uploads', 'archive']);
  });

  it('sorts by creation date, newest first when descending', () => {
    const result = sortBuckets(BUCKETS, { key: 'createdAt', direction: 'desc' });
    expect(result.map((b) => b.bucketName)).toEqual(['archive', 'Uploads', 'media']);
  });

  it('sorts by region label, which is what the row displays', () => {
    // Europe (Amsterdam), Europe (France), US East (Michigan).
    const result = sortBuckets(BUCKETS, { key: 'region', direction: 'asc' });
    expect(result.map((b) => b.region)).toEqual(['eu-central-3', 'eu-west-1', 'us-east-1']);
  });

  it('breaks a region-label tie on the region code', () => {
    // Unknown codes fall back to the code as their label, so two unknowns in the
    // same list must still land in a deterministic order.
    const unknown = [
      bucket({ bucketName: 'a', region: 'zz-south-1' }),
      bucket({ bucketName: 'b', region: 'aa-north-1' }),
    ];
    const result = sortBuckets(unknown, { key: 'region', direction: 'asc' });
    expect(result.map((b) => b.region)).toEqual(['aa-north-1', 'zz-south-1']);
  });

  it('keeps tied rows in their original order in both directions', () => {
    const tied = [
      bucket({ bucketName: 'b', createdAt: '2026-01-01T00:00:00Z' }),
      bucket({ bucketName: 'a', createdAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(
      sortBuckets(tied, { key: 'createdAt', direction: 'asc' }).map((b) => b.bucketName),
    ).toEqual(['b', 'a']);
    expect(
      sortBuckets(tied, { key: 'createdAt', direction: 'desc' }).map((b) => b.bucketName),
    ).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [...BUCKETS];
    sortBuckets(input, { key: 'createdAt', direction: 'desc' });
    expect(input.map((b) => b.bucketName)).toEqual(['archive', 'media', 'Uploads']);
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
