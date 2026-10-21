import { describe, expect, it } from 'vitest';
import { buildPermissions } from './permissions.ts';

describe('buildPermissions', () => {
  it.each([
    ['GetBucketVersioning', 's3:GetBucketVersioning'],
    ['GetBucketObjectLockConfiguration', 's3:GetBucketObjectLockConfiguration'],
  ] as const)('grants %s as %s', (permission, action) => {
    expect(buildPermissions([permission])).toStrictEqual(['s3:ListAllMyBuckets', action]);
  });
});
