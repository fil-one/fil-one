import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { OrgRole, S3Region } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import {
  reviewMemberAccessKeysForRole,
  listOrgAccessKeys,
  reviewAccessKeysForRole,
} from './member-keys.js';
import type { MemberAccessKey } from './member-keys.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const MEMBER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SOMEBODY_ELSE = '99999999-8888-7777-6666-555555555555';

beforeEach(() => {
  ddbMock.reset();
});

function row(overrides: Record<string, unknown> = {}) {
  return marshall(
    {
      pk: `ORG#${ORG_ID}`,
      sk: 'ACCESSKEY#key-1',
      keyName: 'ci',
      accessKeyId: 'AKIAEXAMPLE0001',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      region: S3Region.UsEast1,
      createdBy: MEMBER,
      permissions: ['read', 'write'],
      ...overrides,
    },
    { removeUndefinedValues: true },
  );
}

function key(overrides: Partial<MemberAccessKey> = {}): MemberAccessKey {
  return {
    id: 'key-1',
    keyName: 'ci',
    accessKeyId: 'AKIAEXAMPLE0001',
    region: S3Region.UsEast1,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: MEMBER,
    permissions: ['read', 'write'],
    ...overrides,
  };
}

describe('listOrgAccessKeys', () => {
  it('reads the org partition and shapes each row', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row()] });

    expect(await listOrgAccessKeys(ORG_ID)).toStrictEqual([key()]);
  });

  it('queries the access-key rows of that org alone, consistently', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await listOrgAccessKeys(ORG_ID);

    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${ORG_ID}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
      // A default Query may not yet show a key minted moments before a role
      // change, and that key is exactly the one the pass exists to catch.
      ConsistentRead: true,
    });
  });

  it('follows LastEvaluatedKey to the end of the partition', async () => {
    // A key this pass misses is a credential that outlives the authority to
    // mint it, so a paged answer has to be read whole.
    const page = { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'ACCESSKEY#key-1' } };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [row()], LastEvaluatedKey: page })
      .resolvesOnce({ Items: [row({ sk: 'ACCESSKEY#key-2', keyName: 'backup' })] });

    const keys = await listOrgAccessKeys(ORG_ID);

    expect(keys.map((k) => k.id)).toStrictEqual(['key-1', 'key-2']);
    expect(ddbMock.commandCalls(QueryCommand)[1]!.args[0].input).toMatchObject({
      ExclusiveStartKey: page,
      ConsistentRead: true,
    });
  });

  it('reads a row with no region as Aurora, which is what predates the attribute', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row({ region: undefined })] });

    expect((await listOrgAccessKeys(ORG_ID))[0]!.region).toBe(S3Region.EuWest1);
  });

  it('leaves the optional attributes absent when the row carries none', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [row({ createdBy: undefined, permissions: undefined })] });

    const { createdBy: _createdBy, permissions: _permissions, ...rest } = key();
    expect(await listOrgAccessKeys(ORG_ID)).toStrictEqual([rest]);
  });
});

describe('reviewAccessKeysForRole', () => {
  const ROWS: MemberAccessKey[] = [
    key({ id: 'plain', permissions: ['read', 'write'] }),
    key({ id: 'deletes-buckets', permissions: ['read', 'DeleteBucket'] }),
    key({
      id: 'holds-retention',
      permissions: ['write'],
      granularPermissions: ['PutObjectRetention'],
    }),
    key({ id: 'recovered', permissions: undefined }),
    key({ id: 'somebody-elses', createdBy: SOMEBODY_ELSE, permissions: ['read', 'DeleteBucket'] }),
    key({ id: 'unattributed', createdBy: undefined, permissions: ['read', 'DeleteBucket'] }),
  ];

  it('condemns the keys the new role could not mint, and nobody else’s', () => {
    const review = reviewAccessKeysForRole(ROWS, MEMBER, OrgRole.Member);

    expect(review.keysToRevoke.map((k) => [k.id, k.reason])).toStrictEqual([
      ['deletes-buckets', 'exceeds_role'],
      ['holds-retention', 'exceeds_role'],
      ['recovered', 'permissions_unrecorded'],
    ]);
    expect(review.retainedKeyCount).toBe(1);
    expect(review.unattributedKeyCount).toBe(1);
  });

  it('names what put a key above the new role', () => {
    const review = reviewAccessKeysForRole(ROWS, MEMBER, OrgRole.Member);

    expect(review.keysToRevoke[0]!.excess).toStrictEqual([
      { keyPermission: 'DeleteBucket', requires: 'buckets.delete' },
    ]);
  });

  it('takes every attributed key of theirs on a demotion to ReadOnly', () => {
    const review = reviewAccessKeysForRole(ROWS, MEMBER, OrgRole.ReadOnly);

    expect(review.keysToRevoke.map((k) => [k.id, k.reason])).toStrictEqual([
      ['plain', 'role_cannot_mint'],
      ['deletes-buckets', 'role_cannot_mint'],
      ['holds-retention', 'role_cannot_mint'],
      ['recovered', 'role_cannot_mint'],
    ]);
    expect(review.retainedKeyCount).toBe(0);
  });

  it('condemns nothing on a promotion', () => {
    const review = reviewAccessKeysForRole(ROWS, MEMBER, OrgRole.Owner);

    expect(review.keysToRevoke.map((k) => k.id)).toStrictEqual(['recovered']);
    expect(review.retainedKeyCount).toBe(3);
  });

  it('counts an org with no keys as nothing to do', () => {
    expect(reviewAccessKeysForRole([], MEMBER, OrgRole.ReadOnly)).toStrictEqual({
      keysToRevoke: [],
      retainedKeyCount: 0,
      unattributedKeyCount: 0,
    });
  });
});

describe('reviewMemberAccessKeysForRole', () => {
  it('reads the partition and reviews it in one call', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [row(), row({ sk: 'ACCESSKEY#key-2', permissions: ['DeleteBucket'] })] });

    const review = await reviewMemberAccessKeysForRole(ORG_ID, MEMBER, OrgRole.Member);

    expect(review.keysToRevoke.map((k) => k.id)).toStrictEqual(['key-2']);
    expect(review.retainedKeyCount).toBe(1);
  });
});
