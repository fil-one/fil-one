import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectCommand, GetObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const s3Mock = mockClient(S3Client);

import { deleteReplacedAvatar, isUploadedAvatarUrl } from './avatar-storage.ts';
import { isUploadedOrgLogoUrl } from './org-logo-storage.ts';

const BUCKET_HOST = 'https://OrgLogoBucket.s3.us-east-1.amazonaws.com';

beforeEach(() => {
  s3Mock.reset();
  delete process.env.AWS_REGION;
  s3Mock.on(GetObjectTaggingCommand).resolves({ TagSet: [{ Key: 'state', Value: 'unclaimed' }] });
  s3Mock.on(DeleteObjectCommand).resolves({});
});

describe('isUploadedAvatarUrl', () => {
  it('accepts an unclaimed avatar this bucket holds', async () => {
    expect(await isUploadedAvatarUrl(`${BUCKET_HOST}/avatars/abc`)).toBe(true);
  });

  it('keeps avatars and logos apart, in both directions', async () => {
    expect(await isUploadedAvatarUrl(`${BUCKET_HOST}/logos/abc`)).toBe(false);
    expect(await isUploadedOrgLogoUrl(`${BUCKET_HOST}/avatars/abc`)).toBe(false);
    expect(s3Mock.commandCalls(GetObjectTaggingCommand)).toHaveLength(0);
  });
});

describe('deleteReplacedAvatar', () => {
  it('deletes a replaced avatar of ours', async () => {
    await deleteReplacedAvatar(`${BUCKET_HOST}/avatars/old`);

    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({
      Bucket: 'OrgLogoBucket',
      Key: 'avatars/old',
    });
  });

  it('swallows a failed delete unless asked to rethrow it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    s3Mock.on(DeleteObjectCommand).rejects(new Error('S3 down'));

    await expect(deleteReplacedAvatar(`${BUCKET_HOST}/avatars/old`)).resolves.toBeUndefined();
    await expect(
      deleteReplacedAvatar(`${BUCKET_HOST}/avatars/old`, { rethrow: true }),
    ).rejects.toThrow('S3 down');
  });

  it.each([
    ['a social provider’s picture', 'https://lh3.googleusercontent.com/a/photo'],
    ['an org logo', `${BUCKET_HOST}/logos/abc`],
    ['no picture at all', undefined],
  ])('leaves %s alone', async (_label, url) => {
    await deleteReplacedAvatar(url);

    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});
