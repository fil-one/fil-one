import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.FILONE_STAGE = 'test';

vi.mock('../middleware/auth.js', () => ({
  // Every gate downstream of the auth middleware returns its denials through
  // this helper, so the partial mock has to carry it.
  withRefreshedCookies: (_request: unknown, response: unknown) => response,
  authMiddleware: () => ({ before: () => undefined }),
}));

import { baseHandler, handler } from './list-access-keys.js';
import { buildEvent, buildContext, membershipFor } from '../test/lambda-test-utilities.js';
import { describeRoleEnforcement } from '../test/role-enforcement.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function ddbItem(overrides: {
  id: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  status?: string;
  permissions?: string[];
  granularPermissions?: string[];
  bucketScope?: string;
  buckets?: string[];
  expiresAt?: string;
  region?: string;
  createdBy?: string;
  recovered?: boolean;
}) {
  const item: Record<string, AttributeValue> = {
    pk: { S: `ORG#${USER_INFO.orgId}` },
    sk: { S: `ACCESSKEY#${overrides.id}` },
    keyName: { S: overrides.keyName },
    accessKeyId: { S: overrides.accessKeyId },
    createdAt: { S: overrides.createdAt },
    status: { S: overrides.status ?? 'active' },
  };
  if (overrides.createdBy) item.createdBy = { S: overrides.createdBy };
  if (overrides.recovered) item.recovered = { BOOL: true };
  if (overrides.permissions) item.permissions = { L: overrides.permissions.map((p) => ({ S: p })) };
  if (overrides.granularPermissions)
    item.granularPermissions = { L: overrides.granularPermissions.map((g) => ({ S: g })) };
  if (overrides.bucketScope) item.bucketScope = { S: overrides.bucketScope };
  if (overrides.buckets) item.buckets = { L: overrides.buckets.map((b) => ({ S: b })) };
  if (overrides.expiresAt) item.expiresAt = { S: overrides.expiresAt };
  if (overrides.region) item.region = { S: overrides.region };
  return item;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('list-access-keys baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with mapped key fields from DynamoDB', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Production',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read', 'list'],
          bucketScope: 'all',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      keys: [
        {
          id: 'key-1',
          keyName: 'Production',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          status: 'active',
          permissions: ['read', 'list'],
          bucketScope: 'all',
          region: 'eu-west-1',
          expiresAt: null,
        },
      ],
    });
  });

  it('returns bucket-scoped key with buckets list', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Scoped Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'specific',
          buckets: ['bucket-a', 'bucket-b'],
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0]).toMatchObject({
      bucketScope: 'specific',
      buckets: ['bucket-a', 'bucket-b'],
    });
  });

  it('returns permissions including bucket-management ones', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Bucket Admin',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read', 'CreateBucket', 'DeleteBucket'],
          granularPermissions: ['GetObjectVersion'],
          bucketScope: 'all',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].permissions).toEqual(['read', 'CreateBucket', 'DeleteBucket']);
  });

  it('returns the persisted region from the row', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'FTH Key',
          accessKeyId: 'AKIAFTH',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'all',
          region: 'us-east-1',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].region).toBe('us-east-1');
  });

  it('falls back to S3_REGION (eu-west-1) for legacy rows without region', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-legacy',
          keyName: 'Legacy Key',
          accessKeyId: 'AKIALEGACY',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'all',
          // region attribute deliberately omitted
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].region).toBe('eu-west-1');
  });

  it('returns expiresAt when set', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Expiring Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'all',
          expiresAt: '2026-06-01',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].expiresAt).toBe('2026-06-01');
  });

  it('returns 200 with empty array when no keys exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ keys: [] });
  });

  it('returns multiple keys', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Production',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read', 'write', 'list', 'delete'],
          bucketScope: 'all',
        }),
        ddbItem({
          id: 'key-2',
          keyName: 'Dev',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'all',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0].id).toBe('key-1');
    expect(body.keys[1].id).toBe('key-2');
  });

  it('queries DynamoDB with correct key condition', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toStrictEqual({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: 'ORG#org-1' },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    });
  });

  it('adds FilterExpression when bucket query param is provided', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { bucket: 'my-bucket' },
    });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toStrictEqual({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      FilterExpression: '(bucketScope = :all OR contains(buckets, :bucket))',
      ExpressionAttributeValues: {
        ':pk': { S: 'ORG#org-1' },
        ':skPrefix': { S: 'ACCESSKEY#' },
        ':all': { S: 'all' },
        ':bucket': { S: 'my-bucket' },
      },
    });
  });

  it('does not add FilterExpression when no bucket or region query param', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(QueryCommand);
    const input = calls[0].args[0].input;
    expect(input.FilterExpression).toBeUndefined();
    expect(input.ExpressionAttributeNames).toBeUndefined();
    expect(input.ExpressionAttributeValues).toStrictEqual({
      ':pk': { S: 'ORG#org-1' },
      ':skPrefix': { S: 'ACCESSKEY#' },
    });
  });

  it('filters on region alone, matching only that region', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: 'us-east-1' },
    });
    await baseHandler(event);

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input).toStrictEqual({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      FilterExpression: '#region = :region',
      ExpressionAttributeNames: { '#region': 'region' },
      ExpressionAttributeValues: {
        ':pk': { S: 'ORG#org-1' },
        ':skPrefix': { S: 'ACCESSKEY#' },
        ':region': { S: 'us-east-1' },
      },
    });
  });

  it('also matches region-less legacy rows when filtering on eu-west-1', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: 'eu-west-1' },
    });
    await baseHandler(event);

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.FilterExpression).toBe('(#region = :region OR attribute_not_exists(#region))');
    expect(input.ExpressionAttributeNames).toStrictEqual({ '#region': 'region' });
    expect(input.ExpressionAttributeValues).toStrictEqual({
      ':pk': { S: 'ORG#org-1' },
      ':skPrefix': { S: 'ACCESSKEY#' },
      ':region': { S: 'eu-west-1' },
    });
  });

  it('combines the bucket and region filters', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { bucket: 'my-bucket', region: 'us-east-1' },
    });
    await baseHandler(event);

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input).toStrictEqual({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      FilterExpression: '(bucketScope = :all OR contains(buckets, :bucket)) AND #region = :region',
      ExpressionAttributeNames: { '#region': 'region' },
      ExpressionAttributeValues: {
        ':pk': { S: 'ORG#org-1' },
        ':skPrefix': { S: 'ACCESSKEY#' },
        ':all': { S: 'all' },
        ':bucket': { S: 'my-bucket' },
        ':region': { S: 'us-east-1' },
      },
    });
  });

  it('returns 400 for an unsupported region without querying DynamoDB', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: 'mars-north-1' },
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('returns mapped keys when bucket filter is applied', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'All Access',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read', 'write'],
          bucketScope: 'all',
        }),
        ddbItem({
          id: 'key-2',
          keyName: 'Scoped',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'specific',
          buckets: ['target-bucket'],
        }),
      ],
    });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { bucket: 'target-bucket' },
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      keys: [
        {
          id: 'key-1',
          keyName: 'All Access',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          status: 'active',
          permissions: ['read', 'write'],
          bucketScope: 'all',
          region: 'eu-west-1',
          expiresAt: null,
        },
        {
          id: 'key-2',
          keyName: 'Scoped',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          status: 'active',
          permissions: ['read'],
          bucketScope: 'specific',
          buckets: ['target-bucket'],
          region: 'eu-west-1',
          expiresAt: null,
        },
      ],
    });
  });
  it('logs the org and filter context when the query fails, and rethrows', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('DDB unavailable');
    ddbMock.on(QueryCommand).rejects(failure);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { bucket: 'target-bucket', region: 'us-east-1' },
    });

    await expect(baseHandler(event)).rejects.toThrow('DDB unavailable');
    expect(consoleError).toHaveBeenCalledWith('[list-access-keys] Access key query failed', {
      orgId: 'org-1',
      bucketFilter: 'target-bucket',
      regionFilter: 'us-east-1',
      error: failure,
    });
    consoleError.mockRestore();
  });

  it('records the unfiltered branch when no bucket or region filter is supplied', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).rejects(new Error('DDB unavailable'));

    const event = buildEvent({ userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('DDB unavailable');
    expect(consoleError).toHaveBeenCalledWith(
      '[list-access-keys] Access key query failed',
      expect.objectContaining({ bucketFilter: null, regionFilter: null }),
    );
    consoleError.mockRestore();
  });

  it('does not log on a successful query', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('who sees which keys', () => {
  // `keys.manage_own` is what a Member holds. Before the narrowing below it
  // named a filter nobody applied, and the route handed every member the org's
  // whole key inventory.
  const OWN = ddbItem({
    id: 'key-own',
    keyName: 'Mine',
    accessKeyId: 'AKIAOWN',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: USER_INFO.userId,
  });
  const SOMEONE_ELSES = ddbItem({
    id: 'key-other',
    keyName: 'Theirs',
    accessKeyId: 'AKIAOTHER',
    createdAt: '2026-01-02T00:00:00Z',
    createdBy: 'user-2',
  });
  // Minted before attribution shipped: it names no creator, so nobody can claim
  // it as their own.
  const UNATTRIBUTED = ddbItem({
    id: 'key-legacy',
    keyName: 'Legacy',
    accessKeyId: 'AKIALEGACY',
    createdAt: '2026-01-03T00:00:00Z',
  });
  // Reconstructed after a partial failure: it names the caller who retried, not
  // a confirmed creator, so it is treated like the unattributed row.
  const RECOVERED = ddbItem({
    id: 'key-recovered',
    keyName: 'Recovered',
    accessKeyId: 'AKIARECOVERED',
    createdAt: '2026-01-04T00:00:00Z',
    createdBy: USER_INFO.userId,
    recovered: true,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [OWN, SOMEONE_ELSES, UNATTRIBUTED, RECOVERED] });
  });

  async function keyNamesFor(role: OrgRole) {
    const event = buildEvent({
      userInfo: {
        ...USER_INFO,
        membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role),
      },
    });
    const result = await baseHandler(event);
    return (JSON.parse(result.body!).keys as { keyName: string }[]).map((key) => key.keyName);
  }

  it.each([OrgRole.Owner, OrgRole.Admin])('shows %s every key in the org', async (role) => {
    expect(await keyNamesFor(role)).toStrictEqual(['Mine', 'Theirs', 'Legacy', 'Recovered']);
  });

  it('shows a Member only the keys they created, and not a recovered row naming them', async () => {
    expect(await keyNamesFor(OrgRole.Member)).toStrictEqual(['Mine']);
  });

  it('ships the creator so the console can gate the per-row revoke button', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const keys = JSON.parse((await baseHandler(event)).body!).keys as { createdBy?: string }[];

    expect(keys.map((key) => key.createdBy)).toStrictEqual([
      USER_INFO.userId,
      'user-2',
      // An unattributed row carries no creator rather than a made-up one.
      undefined,
      USER_INFO.userId,
    ]);
  });
});

describeRoleEnforcement({
  permission: 'keys.manage_own',
  invoke: (membership) =>
    handler(buildEvent({ userInfo: { ...USER_INFO, membership } }), buildContext()),
});
