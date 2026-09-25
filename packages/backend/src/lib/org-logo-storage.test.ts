import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteObjectTaggingCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const s3Mock = mockClient(S3Client);

import { isUploadedOrgLogoUrl, withClaimedOrgLogo } from './org-logo-storage.ts';

const BUCKET_HOST = 'https://OrgLogoBucket.s3.us-east-1.amazonaws.com';
const UNCLAIMED = { TagSet: [{ Key: 'state', Value: 'unclaimed' }] };

describe('isUploadedOrgLogoUrl', () => {
  beforeEach(() => {
    s3Mock.reset();
    delete process.env.AWS_REGION;
    s3Mock.on(GetObjectTaggingCommand).resolves(UNCLAIMED);
  });

  it('accepts an unclaimed logo this bucket holds', async () => {
    expect(await isUploadedOrgLogoUrl(`${BUCKET_HOST}/logos/abc`)).toBe(true);
    expect(s3Mock.commandCalls(GetObjectTaggingCommand)[0].args[0].input).toEqual({
      Bucket: 'OrgLogoBucket',
      Key: 'logos/abc',
    });
  });

  it('rejects a logo another save already claimed', async () => {
    s3Mock.on(GetObjectTaggingCommand).resolves({ TagSet: [] });

    expect(await isUploadedOrgLogoUrl(`${BUCKET_HOST}/logos/abc`)).toBe(false);
  });

  it('rejects a URL whose object was never uploaded', async () => {
    s3Mock.on(GetObjectTaggingCommand).rejects(new Error('NoSuchKey'));

    expect(await isUploadedOrgLogoUrl(`${BUCKET_HOST}/logos/never-uploaded`)).toBe(false);
  });

  it.each([
    ['another host', 'https://attacker.example/logos/abc'],
    ['plain http', 'http://OrgLogoBucket.s3.us-east-1.amazonaws.com/logos/abc'],
    ['another region', 'https://OrgLogoBucket.s3.eu-west-1.amazonaws.com/logos/abc'],
    ['another prefix', `${BUCKET_HOST}/other/abc`],
    ['not a URL', 'logos/abc'],
  ])('rejects %s without asking S3', async (_label, url) => {
    expect(await isUploadedOrgLogoUrl(url)).toBe(false);
    expect(s3Mock.commandCalls(GetObjectTaggingCommand)).toHaveLength(0);
  });
});

describe('withClaimedOrgLogo', () => {
  const url = `${BUCKET_HOST}/logos/abc`;

  beforeEach(() => {
    s3Mock.reset();
    delete process.env.AWS_REGION;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    s3Mock.on(DeleteObjectTaggingCommand).resolves({});
    s3Mock.on(PutObjectTaggingCommand).resolves({});
  });

  // A URL saved while the object still carried the tag would be deleted by the
  // lifecycle rule a day later, out from under everything that shows it.
  it('removes the unclaimed tag before the save runs', async () => {
    const order: string[] = [];
    s3Mock.on(DeleteObjectTaggingCommand).callsFake(() => order.push('claim'));

    const result = await withClaimedOrgLogo(url, async () => {
      order.push('save');
      return 'saved';
    });

    expect(result).toBe('saved');
    expect(order).toEqual(['claim', 'save']);
    expect(s3Mock.commandCalls(DeleteObjectTaggingCommand)[0].args[0].input).toEqual({
      Bucket: 'OrgLogoBucket',
      Key: 'logos/abc',
    });
    expect(s3Mock.commandCalls(PutObjectTaggingCommand)).toHaveLength(0);
  });

  it('fails without saving when the claim fails', async () => {
    s3Mock.on(DeleteObjectTaggingCommand).rejects(new Error('AccessDenied'));
    const save = vi.fn();

    await expect(withClaimedOrgLogo(url, save)).rejects.toThrow('AccessDenied');
    expect(save).not.toHaveBeenCalled();
  });

  // So a retry with the same upload still passes the unclaimed check, and an
  // abandoned one still expires.
  it('puts the tag back when the save fails, and reports the save error', async () => {
    await expect(
      withClaimedOrgLogo(url, async () => {
        throw new Error('ConditionalCheckFailed');
      }),
    ).rejects.toThrow('ConditionalCheckFailed');

    expect(s3Mock.commandCalls(PutObjectTaggingCommand)[0].args[0].input).toEqual({
      Bucket: 'OrgLogoBucket',
      Key: 'logos/abc',
      Tagging: { TagSet: [{ Key: 'state', Value: 'unclaimed' }] },
    });
  });

  it('still reports the save error when putting the tag back fails too', async () => {
    s3Mock.on(PutObjectTaggingCommand).rejects(new Error('AccessDenied'));

    await expect(
      withClaimedOrgLogo(url, async () => {
        throw new Error('ConditionalCheckFailed');
      }),
    ).rejects.toThrow('ConditionalCheckFailed');
    expect(console.error).toHaveBeenCalled();
  });
});
