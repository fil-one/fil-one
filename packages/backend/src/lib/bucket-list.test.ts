import { describe, it, expect } from 'vitest';

import type { BucketSummary } from './service-orchestrator.js';
import { filterBucketsByName, sortBuckets } from './bucket-list.js';

type BucketFixture = Omit<BucketSummary, 'region'> & { region: string };

function bucket(overrides: Partial<BucketFixture> & { bucketName: string }): BucketSummary {
  return {
    region: 'eu-west-1',
    createdAt: '2026-01-01T00:00:00Z',
    isPublic: false,
    encrypted: true,
    ...overrides,
  } as BucketSummary;
}

const BUCKETS: BucketSummary[] = [
  bucket({ bucketName: 'archive', region: 'us-east-1', createdAt: '2026-03-01T00:00:00Z' }),
  bucket({ bucketName: 'media', region: 'eu-west-1', createdAt: '2026-01-15T00:00:00Z' }),
  bucket({ bucketName: 'Uploads', region: 'eu-central-3', createdAt: '2026-02-10T00:00:00Z' }),
];

describe('filterBucketsByName', () => {
  it('returns everything for an empty search', () => {
    expect(filterBucketsByName(BUCKETS, '')).toHaveLength(3);
  });

  it('matches the name case-insensitively on a substring', () => {
    const result = filterBucketsByName(BUCKETS, 'LOAD');
    expect(result.map((b) => b.bucketName)).toEqual(['Uploads']);
  });

  it('ignores surrounding whitespace in the search', () => {
    const result = filterBucketsByName(BUCKETS, '  media  ');
    expect(result.map((b) => b.bucketName)).toEqual(['media']);
  });

  it('returns nothing when no name matches', () => {
    expect(filterBucketsByName(BUCKETS, 'nope')).toEqual([]);
  });
});

describe('sortBuckets', () => {
  it('sorts by name ascending, ignoring case', () => {
    const result = sortBuckets(BUCKETS, 'bucketName', 'asc');
    expect(result.map((b) => b.bucketName)).toEqual(['archive', 'media', 'Uploads']);
  });

  it('sorts by name descending', () => {
    const result = sortBuckets(BUCKETS, 'bucketName', 'desc');
    expect(result.map((b) => b.bucketName)).toEqual(['Uploads', 'media', 'archive']);
  });

  it('sorts by creation date, oldest first when ascending', () => {
    const result = sortBuckets(BUCKETS, 'createdAt', 'asc');
    expect(result.map((b) => b.bucketName)).toEqual(['media', 'Uploads', 'archive']);
  });

  it('sorts by creation date, newest first when descending', () => {
    const result = sortBuckets(BUCKETS, 'createdAt', 'desc');
    expect(result.map((b) => b.bucketName)).toEqual(['archive', 'Uploads', 'media']);
  });

  it('sorts by region label, which is what the row displays', () => {
    // Europe (Amsterdam), Europe (France), US East (Michigan).
    const result = sortBuckets(BUCKETS, 'region', 'asc');
    expect(result.map((b) => b.region)).toEqual(['eu-central-3', 'eu-west-1', 'us-east-1']);
  });

  it('breaks a region-label tie on the region code', () => {
    // Unknown codes fall back to the code as their label, so two unknowns in the
    // same list must still land in a deterministic order.
    const unknown = [
      bucket({ bucketName: 'a', region: 'zz-south-1' }),
      bucket({ bucketName: 'b', region: 'aa-north-1' }),
    ];
    const result = sortBuckets(unknown, 'region', 'asc');
    expect(result.map((b) => b.region)).toEqual(['aa-north-1', 'zz-south-1']);
  });

  it('keeps tied rows in their original order in both directions', () => {
    const tied = [
      bucket({ bucketName: 'b', createdAt: '2026-01-01T00:00:00Z' }),
      bucket({ bucketName: 'a', createdAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(sortBuckets(tied, 'createdAt', 'asc').map((b) => b.bucketName)).toEqual(['b', 'a']);
    expect(sortBuckets(tied, 'createdAt', 'desc').map((b) => b.bucketName)).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [...BUCKETS];
    sortBuckets(input, 'createdAt', 'desc');
    expect(input.map((b) => b.bucketName)).toEqual(['archive', 'media', 'Uploads']);
  });
});
