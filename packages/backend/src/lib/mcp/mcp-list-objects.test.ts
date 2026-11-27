import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ListObjectsV2Command, NoSuchBucket, S3Client } from '@aws-sdk/client-s3';
import { OrgRole, S3Region } from '@filone/shared';

vi.mock('sst', () => ({ Resource: {} }));
process.env.FILONE_STAGE = 'any-stage';

const orchestrator = {
  isTenantReady: vi.fn(),
  getS3ClientContext: vi.fn(),
};
vi.mock('../service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: () => orchestrator,
}));
vi.mock('../org-profile.ts', () => ({ getOrgProfile: async () => ({}) }));

const checkMemberBucketAccess = vi.fn();
vi.mock('../../handlers/presign.ts', () => ({
  checkMemberBucketAccess: (...args: unknown[]) => checkMemberBucketAccess(...args),
}));

import { listBucketObjects } from './mcp-list-objects.ts';
import type { OrgMembership } from '../org-membership.ts';
import { NO_MEMBERSHIP, buildEvent, membershipFor } from '../../test/lambda-test-utilities.ts';

const s3Mock = mockClient(S3Client);

const MEMBER = membershipFor('any-org', 'any-user', OrgRole.Member);

function callerEvent(membership: OrgMembership = MEMBER) {
  return buildEvent({
    userInfo: { userId: 'any-user', orgId: 'any-org', membership },
    method: 'POST',
  });
}

const BUCKET_ARGS = { bucketName: 'any-bucket', region: S3Region.EuWest1 };

describe('listBucketObjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Mock.reset();
    orchestrator.isTenantReady.mockReturnValue('any-tenant');
    orchestrator.getS3ClientContext.mockResolvedValue({
      endpointUrl: 'https://s3.any-endpoint.invalid',
      region: S3Region.EuWest1,
      credentials: { accessKeyId: 'any-id', secretAccessKey: 'any-secret' },
      forcePathStyle: true,
      orchestratorId: 'any-orchestrator',
      tenantId: 'any-tenant',
    });
    checkMemberBucketAccess.mockResolvedValue(undefined);
  });

  it('lists the bucket’s objects under the prefix asked for, with the token for the next page', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'docs/a.txt', Size: 3, LastModified: new Date('2026-01-01T00:00:00.000Z') },
      ],
      NextContinuationToken: 'any-next-token',
      IsTruncated: true,
    });

    const result = await listBucketObjects(callerEvent(), {
      ...BUCKET_ARGS,
      prefix: 'docs/',
      maxKeys: 1,
      continuationToken: 'any-token',
    });

    expect(result).toStrictEqual({
      statusCode: 200,
      body: {
        objects: [{ key: 'docs/a.txt', sizeBytes: 3, lastModified: '2026-01-01T00:00:00.000Z' }],
        nextToken: 'any-next-token',
        isTruncated: true,
      },
    });
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input).toStrictEqual({
      Bucket: 'any-bucket',
      Prefix: 'docs/',
      MaxKeys: 1,
      ContinuationToken: 'any-token',
    });
  });

  it('checks the caller’s bucket policies for listing, as the presign route does, and returns its refusal', async () => {
    checkMemberBucketAccess.mockResolvedValue({
      statusCode: 404,
      body: JSON.stringify({ message: 'Bucket not found' }),
    });

    const result = await listBucketObjects(callerEvent(), BUCKET_ARGS);

    expect(checkMemberBucketAccess).toHaveBeenCalledWith(orchestrator, 'any-tenant', 'any-user', [
      { op: 'listObjects', bucket: 'any-bucket' },
    ]);
    expect(result).toStrictEqual({ statusCode: 404, body: { message: 'Bucket not found' } });
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('refuses a caller who is not a member of the org, without listing', async () => {
    // No membership: the caller holds no permission at all.
    const result = await listBucketObjects(
      buildEvent({
        userInfo: { userId: 'any-user', orgId: 'any-org', membership: NO_MEMBERSHIP },
        method: 'POST',
      }),
      BUCKET_ARGS,
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('answers 404 for a bucket the storage system does not have', async () => {
    s3Mock.on(ListObjectsV2Command).rejects(new NoSuchBucket({ message: 'any', $metadata: {} }));

    const result = await listBucketObjects(callerEvent(), BUCKET_ARGS);

    expect(result).toStrictEqual({ statusCode: 404, body: { message: 'Bucket not found' } });
  });
});
