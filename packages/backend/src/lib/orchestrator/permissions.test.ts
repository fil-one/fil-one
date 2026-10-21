import { describe, expect, it } from 'vitest';
import { buildPermissions } from './permissions.ts';

describe('buildPermissions', () => {
  // Each permission carries the actions Hilt authorized as its plain bucket
  // or object operation before fil-forge/hilt#102: the bucket's location,
  // ACL, CORS and tag reads with s3:ListBucket, and the object's tags and
  // attributes with the object operation.
  it.each([
    [
      'read',
      [
        's3:GetObject',
        's3:ListBucket',
        's3:ListMultipartUploadParts',
        's3:GetObjectTagging',
        's3:GetObjectAttributes',
        's3:GetBucketLocation',
        's3:GetBucketAcl',
        's3:GetBucketCORS',
        's3:GetBucketTagging',
      ],
    ],
    ['write', ['s3:PutObject', 's3:AbortMultipartUpload', 's3:PutObjectTagging']],
    [
      'list',
      [
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
        's3:GetBucketLocation',
        's3:GetBucketAcl',
        's3:GetBucketCORS',
        's3:GetBucketTagging',
      ],
    ],
    ['delete', ['s3:DeleteObject', 's3:DeleteObjectTagging']],
  ] as const)(
    'grants %s as its actions and the tag and configuration reads it covered',
    (permission, actions) => {
      expect(buildPermissions([permission])).toStrictEqual(['s3:ListAllMyBuckets', ...actions]);
    },
  );

  it.each([
    ['GetBucketVersioning', 's3:GetBucketVersioning'],
    ['GetBucketObjectLockConfiguration', 's3:GetBucketObjectLockConfiguration'],
  ] as const)('grants %s as %s', (permission, action) => {
    expect(buildPermissions([permission])).toStrictEqual(['s3:ListAllMyBuckets', action]);
  });
});
