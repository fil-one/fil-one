import { describe, expect, it } from 'vitest';
import { buildPermissions } from './permissions.ts';

describe('buildPermissions', () => {
  // Each permission includes the tag, attribute and bucket configuration
  // actions of the operations it allows.
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
        's3:GetEncryptionConfiguration',
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
        's3:GetEncryptionConfiguration',
      ],
    ],
    ['delete', ['s3:DeleteObject', 's3:DeleteObjectTagging']],
  ] as const)(
    'grants %s as its object, tag and bucket configuration actions',
    (permission, actions) => {
      expect(buildPermissions([permission])).toStrictEqual(['s3:ListAllMyBuckets', ...actions]);
    },
  );

  it.each([
    ['GetBucketVersioning', 's3:GetBucketVersioning'],
    ['GetBucketObjectLockConfiguration', 's3:GetBucketObjectLockConfiguration'],
    ['PutBucketCORS', 's3:PutBucketCORS'],
  ] as const)('grants %s as %s', (permission, action) => {
    expect(buildPermissions([permission])).toStrictEqual(['s3:ListAllMyBuckets', action]);
  });
});
