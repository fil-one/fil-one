import { describe, it, expect } from 'vitest';
import {
  CreateBucketSchema,
  isRagCompanionBucket,
  listBucketsUnavailableMessage,
} from './buckets.ts';
import { S3Region } from '../constants.ts';

const validRetention = (
  overrides: Partial<{
    enabled: true;
    mode: 'governance' | 'compliance';
    duration: number;
    durationType: 'd' | 'y';
  }> = {},
) => ({
  enabled: true as const,
  mode: 'governance' as const,
  duration: 15,
  durationType: 'd' as const,
  ...overrides,
});

describe('CreateBucketSchema', () => {
  describe('default values', () => {
    it('sets versioning=false and lock=false when omitted', () => {
      const result = CreateBucketSchema.parse({ bucketName: 'my-bucket', region: 'eu-west-1' });
      expect(result.versioning).toBe(false);
      expect(result.lock).toBe(false);
      expect(result.retention).toBeUndefined();
    });
  });

  describe('valid combinations', () => {
    it('versioning OFF, lock OFF, no retention', () => {
      const result = CreateBucketSchema.parse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: false,
        lock: false,
      });
      expect(result.versioning).toBe(false);
      expect(result.lock).toBe(false);
    });

    it('versioning ON, lock OFF, no retention', () => {
      const result = CreateBucketSchema.parse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: false,
      });
      expect(result.versioning).toBe(true);
      expect(result.lock).toBe(false);
    });

    it('versioning ON, lock ON, no retention', () => {
      const result = CreateBucketSchema.parse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: true,
      });
      expect(result.versioning).toBe(true);
      expect(result.lock).toBe(true);
    });

    it('versioning ON, lock ON, governance retention', () => {
      const result = CreateBucketSchema.parse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: true,
        retention: validRetention({ mode: 'governance', duration: 15, durationType: 'd' }),
      });
      expect(result.retention).toEqual({
        enabled: true,
        mode: 'governance',
        duration: 15,
        durationType: 'd',
      });
    });

    it('versioning ON, lock ON, compliance retention', () => {
      const result = CreateBucketSchema.parse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: true,
        retention: validRetention({ mode: 'compliance', duration: 1, durationType: 'y' }),
      });
      expect(result.retention).toEqual({
        enabled: true,
        mode: 'compliance',
        duration: 1,
        durationType: 'y',
      });
    });
  });

  it('reserves the Bucket Intelligence companion bucket prefix', () => {
    const result = CreateBucketSchema.safeParse({
      bucketName: 'filone-rag-abc',
      region: 'eu-central-3',
    });
    expect(result).toMatchZodValidationError({
      path: ['bucketName'],
      message: 'Bucket names starting with "filone-rag-" are reserved.',
    });
  });

  it('accepts names that only contain the prefix later on', () => {
    expect(
      CreateBucketSchema.safeParse({ bucketName: 'my-filone-rag-notes', region: 'eu-west-1' }),
    ).toMatchObject({ success: true });
  });

  describe('invalid combinations', () => {
    it('rejects lock ON without versioning', () => {
      const result = CreateBucketSchema.safeParse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: false,
        lock: true,
      });
      expect(result).toMatchZodValidationError({
        path: ['lock'],
        message: 'Versioning must be enabled to use Object Lock',
      });
    });

    it('rejects retention without lock', () => {
      const result = CreateBucketSchema.safeParse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: true,
        lock: false,
        retention: validRetention(),
      });
      expect(result).toMatchZodValidationError({
        path: ['retention'],
        message: 'Object Lock must be enabled to use Retention',
      });
    });

    it('rejects retention without versioning', () => {
      const result = CreateBucketSchema.safeParse({
        bucketName: 'my-bucket',
        region: 'eu-west-1',
        versioning: false,
        lock: false,
        retention: validRetention(),
      });
      expect(result).toMatchZodValidationError({
        path: ['retention'],
        message: 'Object Lock must be enabled to use Retention',
      });
    });
  });

  describe('duration bounds', () => {
    const base = {
      bucketName: 'my-bucket',
      region: 'eu-west-1',
      versioning: true,
      lock: true,
    };

    it('rejects duration of 0', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 0 }),
      });
      expect(result).toMatchZodValidationError({
        code: 'too_small',
        path: ['retention', 'duration'],
      });
    });

    it('accepts duration of 1', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 1 }),
      });
      expect(result).toMatchObject({ success: true });
    });

    it('accepts duration of 36500', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 36500 }),
      });
      expect(result).toMatchObject({ success: true });
    });

    it('rejects duration of 36501', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 36501 }),
      });
      expect(result).toMatchZodValidationError({
        path: ['retention', 'duration'],
        message: 'Duration exceeds the maximum allowed',
      });
    });

    it('accepts years duration of 100', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 100, durationType: 'y' }),
      });
      expect(result).toMatchObject({ success: true });
    });

    it('rejects years duration of 101', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 101, durationType: 'y' }),
      });
      expect(result).toMatchZodValidationError({
        path: ['retention', 'duration'],
        message: 'Duration exceeds the maximum allowed',
      });
    });

    it('rejects non-integer duration', () => {
      const result = CreateBucketSchema.safeParse({
        ...base,
        retention: validRetention({ duration: 1.5 }),
      });
      expect(result).toMatchZodValidationError({
        code: 'invalid_type',
        expected: 'int',
        path: ['retention', 'duration'],
      });
    });
  });
});

describe('listBucketsUnavailableMessage', () => {
  it('names a single region in the singular', () => {
    expect(listBucketsUnavailableMessage([S3Region.UsEast1])).toBe(
      'Cannot list buckets in the us-east-1 region. Please try again later.',
    );
  });

  it('joins two regions with "and" and pluralises', () => {
    expect(listBucketsUnavailableMessage([S3Region.EuWest1, S3Region.UsEast1])).toBe(
      'Cannot list buckets in the eu-west-1 and us-east-1 regions. Please try again later.',
    );
  });

  it('comma-separates all but the last of three regions', () => {
    expect(
      listBucketsUnavailableMessage([S3Region.EuWest1, S3Region.UsEast1, S3Region.EuCentral3]),
    ).toBe(
      'Cannot list buckets in the eu-west-1, us-east-1 and eu-central-3 regions. ' +
        'Please try again later.',
    );
  });
});

describe('isRagCompanionBucket', () => {
  it('matches the companion name shape: the prefix and 40 hex characters', () => {
    expect(isRagCompanionBucket('filone-rag-0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it.each([
    'filone-rag-docs',
    'filone-rag-0123456789abcdef0123456789abcdef0123456',
    'filone-rag-0123456789abcdef0123456789abcdef012345678',
    'filone-rag-0123456789ABCDEF0123456789abcdef01234567',
    'x-filone-rag-0123456789abcdef0123456789abcdef01234567',
    'my-bucket',
  ])('leaves %s visible', (name) => {
    expect(isRagCompanionBucket(name)).toBe(false);
  });
});
