import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { ApiErrorCode, SubscriptionStatus } from '@filone/shared';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

vi.mock('../lib/user-context.js', () => ({
  getUserInfo: (event: AuthenticatedEvent) => event.requestContext.userInfo,
}));

const ddbMock = mockClient(DynamoDBClient);

import { rateLimitMiddleware } from './rate-limit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function buildRateLimitEvent(ops: unknown[], overrides?: { subscriptionStatus?: string | null }) {
  const event = buildEvent({
    body: JSON.stringify(ops),
    userInfo: USER_INFO,
  });
  const status =
    overrides?.subscriptionStatus === undefined
      ? SubscriptionStatus.Active
      : overrides.subscriptionStatus;
  if (status) {
    event.requestContext.subscriptionStatus = status;
  }
  return event;
}

function ddbReturnsCount(count: number) {
  ddbMock.on(UpdateItemCommand).resolves({
    Attributes: { count: { N: String(count) } },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimitMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('allows request when under limit', async () => {
    ddbReturnsCount(5);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await middleware.before(buildMiddyRequest(event));

    expect(result).toBeUndefined();
  });

  it('returns 429 when over paid limit', async () => {
    ddbReturnsCount(201);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await middleware.before(buildMiddyRequest(event));

    expect(result).toMatchObject({
      statusCode: 429,
      body: expect.stringContaining(ApiErrorCode.RATE_LIMIT_EXCEEDED),
    });
    expect(result!.headers).toHaveProperty('Retry-After');
  });

  it('counts operations not requests', async () => {
    ddbReturnsCount(10);
    const middleware = rateLimitMiddleware();
    const ops = Array.from({ length: 10 }, (_, i) => ({
      op: 'listObjects',
      bucket: `b${i}`,
    }));
    const event = buildRateLimitEvent(ops);
    await middleware.before(buildMiddyRequest(event));

    const call = ddbMock.commandCalls(UpdateItemCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':ops'].N).toBe('10');
  });

  it('uses trial limit for trialing users', async () => {
    ddbReturnsCount(61);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }], {
      subscriptionStatus: SubscriptionStatus.Trialing,
    });
    const result = await middleware.before(buildMiddyRequest(event));

    expect(result).toMatchObject({
      statusCode: 429,
      body: expect.stringContaining('60'),
    });
  });

  it('uses trial limit when no subscription status', async () => {
    ddbReturnsCount(61);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }], {
      subscriptionStatus: null,
    });
    const result = await middleware.before(buildMiddyRequest(event));

    expect(result).toMatchObject({ statusCode: 429 });
  });

  it('uses full limit for active users', async () => {
    ddbReturnsCount(61);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await middleware.before(buildMiddyRequest(event));

    // 61 is under the 200 paid limit
    expect(result).toBeUndefined();
  });

  it('uses correct DynamoDB key format', async () => {
    ddbReturnsCount(1);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    await middleware.before(buildMiddyRequest(event));

    const call = ddbMock.commandCalls(UpdateItemCommand)[0];
    const key = call.args[0].input.Key!;
    expect(key.pk.S).toBe('RATELIMIT#presign#user-1');
    expect(key.sk.S).toMatch(/^WINDOW#\d+$/);
  });

  it('sets TTL on the DynamoDB item', async () => {
    ddbReturnsCount(1);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    await middleware.before(buildMiddyRequest(event));

    const call = ddbMock.commandCalls(UpdateItemCommand)[0];
    const ttl = parseInt(call.args[0].input.ExpressionAttributeValues![':ttl'].N!, 10);
    // TTL should be in the future
    expect(ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('includes Retry-After header in 429 response', async () => {
    ddbReturnsCount(201);
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await middleware.before(buildMiddyRequest(event));

    const retryAfter = parseInt(result!.headers!['Retry-After'] as string, 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('handles unparseable body gracefully', async () => {
    ddbReturnsCount(1);
    const middleware = rateLimitMiddleware();
    const event = buildEvent({ body: 'not json', userInfo: USER_INFO });
    event.requestContext.subscriptionStatus = SubscriptionStatus.Active;
    await middleware.before(buildMiddyRequest(event));

    const call = ddbMock.commandCalls(UpdateItemCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':ops'].N).toBe('1');
  });

  it('handles missing body gracefully', async () => {
    ddbReturnsCount(1);
    const middleware = rateLimitMiddleware();
    const event = buildEvent({ userInfo: USER_INFO });
    event.requestContext.subscriptionStatus = SubscriptionStatus.Active;
    await middleware.before(buildMiddyRequest(event));

    const call = ddbMock.commandCalls(UpdateItemCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':ops'].N).toBe('1');
  });

  it('fails open on DynamoDB error', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('DDB timeout'));
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = rateLimitMiddleware();
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await middleware.before(buildMiddyRequest(event));

    expect(result).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[rate-limit] DynamoDB error, allowing request',
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });

  it('respects custom config', async () => {
    ddbReturnsCount(11);
    const middleware = rateLimitMiddleware({ limit: 10 });
    const event = buildRateLimitEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await middleware.before(buildMiddyRequest(event));

    expect(result).toMatchObject({ statusCode: 429 });
  });
});
