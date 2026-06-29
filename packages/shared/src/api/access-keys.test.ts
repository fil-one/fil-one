import { describe, it, expect } from 'vitest';
import { S3Region } from '../constants.js';
import {
  ACCESS_KEY_PERMISSIONS,
  BUCKET_PERMISSIONS,
  CreateAccessKeySchema,
  GRANULAR_PERMISSIONS,
  isBucketPermission,
  isObjectPermission,
} from './access-keys.js';

describe('BUCKET_PERMISSIONS', () => {
  it('contains the configurable bucket-management actions', () => {
    expect([...BUCKET_PERMISSIONS]).toEqual(['CreateBucket', 'DeleteBucket']);
  });

  it('are part of the access-key permission set', () => {
    for (const p of BUCKET_PERMISSIONS) {
      expect(ACCESS_KEY_PERMISSIONS).toContain(p);
    }
  });

  it('are not part of the granular permission set', () => {
    for (const p of BUCKET_PERMISSIONS) {
      expect(GRANULAR_PERMISSIONS).not.toContain(p);
    }
  });
});

describe('isBucketPermission', () => {
  it('returns true for bucket-management permissions', () => {
    expect(isBucketPermission('CreateBucket')).toBe(true);
    expect(isBucketPermission('DeleteBucket')).toBe(true);
  });

  it('returns false for object permissions', () => {
    expect(isBucketPermission('read')).toBe(false);
  });
});

describe('isObjectPermission', () => {
  it('returns true for object permissions', () => {
    expect(isObjectPermission('read')).toBe(true);
  });

  it('returns false for bucket-management permissions', () => {
    expect(isObjectPermission('CreateBucket')).toBe(false);
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
      permissions: ['read', 'CreateBucket'],
      region: S3Region.UsEast1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects CreateBucket in the Aurora region', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: ['read', 'CreateBucket'],
      region: S3Region.EuWest1,
    });
    expect(result.success).toBe(false);
  });

  it('allows a bucket-only key (no object permissions) in a non-Aurora region', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: ['CreateBucket'],
      region: S3Region.UsEast1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a key with no permissions', () => {
    const result = CreateAccessKeySchema.safeParse({
      ...base,
      permissions: [],
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
