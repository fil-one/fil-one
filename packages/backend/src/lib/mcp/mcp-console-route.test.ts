import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiErrorCode, OrgRole, SubscriptionStatus } from '@filone/shared';

vi.mock('sst', () => ({ Resource: {} }));

const getSubscription = vi.fn();
vi.mock('../subscription-store.ts', () => ({
  getSubscription: (...args: unknown[]) => getSubscription(...args),
  updateSubscription: vi.fn(),
}));

import { callConsoleRoute, type ConsoleHandler } from './mcp-console-route.ts';
import { AccessLevel } from '../../middleware/subscription-guard.ts';
import { buildEvent, membershipFor } from '../../test/lambda-test-utilities.ts';

function mcpEvent(role: OrgRole) {
  return buildEvent({
    userInfo: {
      userId: 'any-user',
      orgId: 'any-org',
      membership: membershipFor('any-org', 'any-user', role),
    },
    method: 'POST',
    body: '{"jsonrpc":"2.0"}',
  });
}

const baseHandler = vi.fn<ConsoleHandler>();

describe('callConsoleRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseHandler.mockResolvedValue({ statusCode: 200, body: JSON.stringify({ any: 'result' }) });
    getSubscription.mockResolvedValue({
      pk: 'ORG#any-org',
      subscriptionId: 'sub_any',
      subscriptionStatus: SubscriptionStatus.Active,
    });
  });

  it('calls the route’s handler as the caller, with the path, query and JSON body given, and returns its answer', async () => {
    const result = await callConsoleRoute(mcpEvent(OrgRole.Member), {
      handler: 'get-bucket',
      baseHandler,
      accessLevel: AccessLevel.Read,
      pathParameters: { name: 'any-bucket' },
      queryStringParameters: { region: 'any-region' },
      body: { any: 'input' },
    });

    expect(result).toStrictEqual({ statusCode: 200, body: { any: 'result' } });
    expect(baseHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        pathParameters: { name: 'any-bucket' },
        queryStringParameters: { region: 'any-region' },
        body: '{"any":"input"}',
        requestContext: expect.objectContaining({
          userInfo: expect.objectContaining({ userId: 'any-user', orgId: 'any-org' }),
        }),
      }),
    );
  });

  it('refuses without calling the handler when the caller’s role lacks the permission the route manifest names', async () => {
    // delete-bucket requires buckets.delete, which a read-only member lacks.
    const result = await callConsoleRoute(mcpEvent(OrgRole.ReadOnly), {
      handler: 'delete-bucket',
      baseHandler,
      accessLevel: AccessLevel.Write,
    });

    expect(result).toMatchObject({ statusCode: 403 });
    expect(baseHandler).not.toHaveBeenCalled();
  });

  it('refuses a write-level route without calling the handler while the org is in a grace period', async () => {
    getSubscription.mockResolvedValue({
      pk: 'ORG#any-org',
      subscriptionId: 'sub_any',
      subscriptionStatus: SubscriptionStatus.GracePeriod,
      gracePeriodEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const result = await callConsoleRoute(mcpEvent(OrgRole.Owner), {
      handler: 'delete-bucket',
      baseHandler,
      accessLevel: AccessLevel.Write,
    });

    expect(result).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED },
    });
    expect(baseHandler).not.toHaveBeenCalled();
  });

  it('returns no body for a route that answers 204', async () => {
    baseHandler.mockResolvedValue({ statusCode: 204, body: '' });

    const result = await callConsoleRoute(mcpEvent(OrgRole.Owner), {
      handler: 'delete-bucket',
      baseHandler,
      accessLevel: AccessLevel.Write,
    });

    expect(result).toStrictEqual({ statusCode: 204, body: undefined });
  });
});
