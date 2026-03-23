import { describe, it, expect } from 'vitest';
import { NoSuchBucket } from '@aws-sdk/client-s3';
import { isNoSuchBucketError } from './s3-errors.js';

describe('isNoSuchBucketError', () => {
  it('returns true for a NoSuchBucket error from the SDK', () => {
    const err = new NoSuchBucket({
      message: 'The specified bucket does not exist',
      $metadata: {},
    });

    expect(isNoSuchBucketError(err)).toBe(true);
  });

  it('returns false for a generic Error', () => {
    expect(isNoSuchBucketError(new Error('something else'))).toBe(false);
  });

  it('returns false for a non-error value', () => {
    expect(isNoSuchBucketError('NoSuchBucket')).toBe(false);
  });
});
