import { describe, expect, it } from 'vitest';

import { S3Region, type Bucket } from '@filone/shared';

import { DEFAULT_BUCKET_SORT, EMPTY_BUCKET_FILTERS, type BucketSort } from './bucket-table.js';
import { withDemoBucket } from './cold-storage-prototype.js';

function bucket(bucketName: string, overrides: Partial<Bucket> = {}): Bucket {
  return {
    bucketName,
    region: S3Region.EuWest1,
    createdAt: '2026-01-01T00:00:00Z',
    isPublic: false,
    ...overrides,
  };
}

const demo = bucket('mm-demo', { createdAt: '2026-03-01T00:00:00Z' });
const names = (buckets: Bucket[]) => buckets.map((b) => b.bucketName);

describe('withDemoBucket', () => {
  it('returns the list unchanged when there is no demo bucket', () => {
    const listed = [bucket('any-a')];
    expect(withDemoBucket(listed, null, EMPTY_BUCKET_FILTERS, DEFAULT_BUCKET_SORT)).toBe(listed);
  });

  it.each<[string, BucketSort, string[]]>([
    ['name ascending', { key: 'bucketName', direction: 'asc' }, ['aa', 'mm-demo', 'zz']],
    ['name descending', { key: 'bucketName', direction: 'desc' }, ['zz', 'mm-demo', 'aa']],
    ['creation date ascending', { key: 'createdAt', direction: 'asc' }, ['aa', 'mm-demo', 'zz']],
  ])('inserts the demo bucket in %s order', (_, sort, expected) => {
    // Already sorted the way `sort` says, as the backend returns them.
    const sorted = [
      bucket('aa', { createdAt: '2026-02-01T00:00:00Z' }),
      bucket('zz', { createdAt: '2026-04-01T00:00:00Z' }),
    ];
    const listed = sort.direction === 'desc' ? [...sorted].reverse() : sorted;
    expect(names(withDemoBucket(listed, demo, EMPTY_BUCKET_FILTERS, sort))).toStrictEqual(expected);
  });

  it('adds the demo bucket last when it sorts after every listed bucket', () => {
    const listed = [bucket('aa'), bucket('bb')];
    expect(
      names(withDemoBucket(listed, demo, EMPTY_BUCKET_FILTERS, DEFAULT_BUCKET_SORT)),
    ).toStrictEqual(['aa', 'bb', 'mm-demo']);
  });

  it.each([
    // The demo bucket's name doesn't contain the search.
    ['a search that misses its name', { query: 'invoices', region: 'all' }],
    // The demo bucket is in eu-west-1.
    ['a region filter for another region', { query: '', region: S3Region.UsEast1 }],
  ])('leaves the demo bucket out under %s', (_, filters) => {
    const listed = [bucket('aa')];
    expect(names(withDemoBucket(listed, demo, filters, DEFAULT_BUCKET_SORT))).toStrictEqual(['aa']);
  });

  it('keeps the demo bucket under a search that matches its name in another case', () => {
    expect(
      names(withDemoBucket([], demo, { query: 'MM-', region: 'all' }, DEFAULT_BUCKET_SORT)),
    ).toStrictEqual(['mm-demo']);
  });

  it('adds nothing when the listing already holds a bucket of the same name', () => {
    const listed = [bucket('mm-demo')];
    expect(withDemoBucket(listed, demo, EMPTY_BUCKET_FILTERS, DEFAULT_BUCKET_SORT)).toBe(listed);
  });
});
