import { describe, it, expect } from 'vitest';
import { S3Region } from '../constants.js';
import {
  BUCKET_PERMISSIONS,
  CreateAccessKeySchema,
  GRANULAR_PERMISSIONS,
  isBucketPermission,
} from './access-keys.js';

describe('BUCKET_PERMISSIONS', () => {
  it('contains the configurable bucket-management actions', () => {
    expect([...BUCKET_PERMISSIONS]).toEqual(['CreateBucket', 'DeleteBucket']);
  });

  it('are part of the granular permission set', () => {
    for (const p of BUCKET_PERMISSIONS) {
      expect(GRANULAR_PERMISSIONS).toContain(p);
    }
  });
});

describe('isBucketPermission', () => {
  it('returns true for bucket-management granulars', () => {
    expect(isBucketPermission('CreateBucket')).toBe(true);
    expect(isBucketPermission('DeleteBucket')).toBe(true);
  });

  it('returns false for data-protection granulars', () => {
    expect(isBucketPermission('GetObjectVersion')).toBe(false);
  });
});

describe('CreateAccessKeySchema bucket permissions', () => {
  const base = {
    keyName: 'My Key',
    bucketScope: 'all' as const,
  };

  it('accepts CreateBucket in a non-Aurora region', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: ['read'],
      granularPermissions: ['CreateBucket'],
      region: S3Region.UsEast1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects CreateBucket in the Aurora region', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: ['read'],
      granularPermissions: ['CreateBucket'],
      region: S3Region.EuWest1,
    });
    expect(result.success).toBe(false);
  });

  it('allows a bucket-only key (no object permissions) in a non-Aurora region', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: [],
      granularPermissions: ['CreateBucket'],
      region: S3Region.UsEast1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a key with no object permissions and no bucket permissions', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: [],
      granularPermissions: [],
      region: S3Region.UsEast1,
    });
    expect(result.success).toBe(false);
  });

  it('still requires a data-protection granular to belong to a selected basic', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: ['list'],
      granularPermissions: ['GetObjectVersion'], // belongs to `read`, not `list`
      region: S3Region.UsEast1,
    });
    expect(result.success).toBe(false);
  });
});
