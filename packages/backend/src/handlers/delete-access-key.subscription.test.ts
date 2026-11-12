import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());

const deleteAccessKey = vi.fn();

vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: () => ({
    id: 'aurora',
    region: 'eu-west-1',
    isTenantReady: () => 'tenant-1',
    deleteAccessKey: (...args: unknown[]) => deleteAccessKey(...args),
  }),
}));

vi.mock('../lib/org-profile.ts', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

// The chain's other middleware is stubbed to a pass-through so the subscription
// guard is the only gate left between the request and the handler. The guard
// itself is deliberately NOT mocked: it is what this file is about.
vi.mock('../middleware/auth.ts', () => ({
  authMiddleware: () => ({ before: () => undefined }),
  withRefreshedCookies: (_request: unknown, response: unknown) => response,
}));
vi.mock('../middleware/authorize.ts', () => ({
  authorize: () => ({ before: () => undefined }),
  requireOrgMembershipMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/csrf.ts', () => ({
  csrfMiddleware: () => ({ before: () => undefined }),
}));

const getSubscription = vi.fn();
vi.mock('../lib/subscription-store.ts', () => ({
  getSubscription: (...args: unknown[]) => getSubscription(...args),
  updateSubscription: vi.fn(),
}));

const ddbMock = mockClient(DynamoDBClient);

import { ApiErrorCode, SubscriptionStatus } from '@filone/shared';
import { handler } from './delete-access-key.ts';
import { handler as rotateHandler } from './rotate-access-key.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

const KEY_ID = 'key-1';

function revokeRequest() {
  const event = buildEvent({
    userInfo: { userId: 'any-user', orgId: 'any-org' },
    method: 'DELETE',
  });
  return Object.assign(event, { pathParameters: { keyId: KEY_ID } });
}

/**
 * Revocation is the operation that removes authority, so billing health must
 * not gate it: an org discovers a compromised key precisely when its billing is
 * most likely to be unhealthy, and a write-locked tenant keeps serving reads to
 * the key it cannot revoke.
 *
 * `active` is the control. It passes whether or not the route is guarded, so it
 * proves the fixture reaches the orchestrator at all; the other states are the
 * ones that used to return 403 before the handler body ran.
 */
describe('revoking an access key, by subscription state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'ORG#any-org' },
        sk: { S: `ACCESSKEY#${KEY_ID}` },
        keyName: { S: 'any-key' },
        accessKeyId: { S: 'AKIAEXAMPLE0001' },
        createdAt: { S: '2026-01-01T00:00:00Z' },
        status: { S: 'active' },
        region: { S: 'eu-west-1' },
      },
    });
    deleteAccessKey.mockResolvedValue(undefined);
  });

  it.each([
    ['active', SubscriptionStatus.Active],
    ['grace_period', SubscriptionStatus.GracePeriod],
    ['past_due', SubscriptionStatus.PastDue],
    ['canceled', SubscriptionStatus.Canceled],
  ])('reaches the orchestrator for an org whose subscription is %s', async (_name, status) => {
    getSubscription.mockResolvedValue({
      pk: 'ORG#any-org',
      subscriptionId: 'sub_any',
      subscriptionStatus: status,
    });

    const result = (await handler(revokeRequest(), {} as never)) as { statusCode: number };

    expect(result).toMatchObject({ statusCode: 204 });
    expect(deleteAccessKey).toHaveBeenCalledWith('tenant-1', KEY_ID);
  });
});

/**
 * Rotation carries the same property, and carried the same guard. Its success
 * path needs a mint fixture this file has no business building, so the
 * assertion is that the request reaches the handler body at all: the body's
 * first act is to read the key row, and an absent row is a 404 only the body
 * can produce. A guarded route answers 403 before the body ever runs.
 */
describe('rotating an access key, by subscription state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    // No row for the key, so the body's own lookup is what answers.
    ddbMock.on(GetItemCommand).resolves({});
  });

  it.each([
    ['active', SubscriptionStatus.Active],
    ['grace_period', SubscriptionStatus.GracePeriod],
    ['past_due', SubscriptionStatus.PastDue],
    ['canceled', SubscriptionStatus.Canceled],
  ])('reaches the handler body for an org whose subscription is %s', async (_name, status) => {
    getSubscription.mockResolvedValue({
      pk: 'ORG#any-org',
      subscriptionId: 'sub_any',
      subscriptionStatus: status,
    });

    const event = buildEvent({
      userInfo: { userId: 'any-user', orgId: 'any-org' },
      method: 'POST',
      body: '{}',
    });
    const result = (await rotateHandler(
      Object.assign(event, { pathParameters: { keyId: KEY_ID } }),
      {} as never,
    )) as { statusCode: number; body: string };

    expect(result).toMatchObject({ statusCode: 404 });
    expect(JSON.parse(result.body)).not.toMatchObject({
      code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED,
    });
  });
});
