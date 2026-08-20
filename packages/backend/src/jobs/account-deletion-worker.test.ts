import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const order: string[] = [];
const mockTearDownStripe = vi.fn(async () => void order.push('stripe'));
const mockScrub = vi.fn(async () => void order.push('scrub'));
const mockDeleteAuth0User = vi.fn(async (sub: string) => void order.push(`auth0:${sub}`));
const mockGetAuth0UserEmail = vi.fn(async (sub: string) => {
  order.push(`email:${sub}`);
  return 'user@example.com' as string | undefined;
});
const mockDeleteTenant = vi.fn(async (tenantId: string) => void order.push(`tenant:${tenantId}`));
const mockResolveTargets = vi.fn(async () => ({
  members: [{ userId: 'user-1', sub: 'auth0|one' }],
  tenantIds: { fth: '42' } as Record<string, string>,
}));

vi.mock('../lib/deletion-stripe-teardown.js', () => ({
  tearDownStripe: () => mockTearDownStripe(),
}));
vi.mock('../lib/deletion-scrub.js', () => ({ scrubOrgRecords: () => mockScrub() }));
vi.mock('../lib/deletion-targets.js', () => ({
  resolveDeletionTargets: () => mockResolveTargets(),
}));
vi.mock('../lib/auth0-management.js', () => ({
  deleteAuth0User: (sub: string) => mockDeleteAuth0User(sub),
  getAuth0UserEmail: (sub: string) => mockGetAuth0UserEmail(sub),
}));

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: () => mockGetAvailableOrchestrators(),
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './account-deletion-worker.js';

const ORG = 'org-1';

function record(over: Record<string, unknown> = {}) {
  return marshall({
    pk: `ORG#${ORG}`,
    sk: 'DELETION',
    status: 'PENDING',
    trigger: 'USER_REQUEST',
    requestedAt: '2026-08-12T10:00:00.000Z',
    requestedByUserId: 'user-1',
    attempts: 0,
    updatedAt: '2026-08-12T10:00:00.000Z',
    ...over,
  });
}

function orchestrator(id: string, deleteTenant = mockDeleteTenant) {
  return { id, deleteTenant };
}

describe('account-deletion-worker', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    order.length = 0;
    ddbMock.on(GetItemCommand).resolves({ Item: record() });
    ddbMock.on(UpdateItemCommand).resolves({});
    mockResolveTargets.mockResolvedValue({
      members: [{ userId: 'user-1', sub: 'auth0|one' }],
      tenantIds: { fth: '42' },
    });
    mockGetAvailableOrchestrators.mockReturnValue([orchestrator('fth')]);
  });

  // Auth0 first because it holds the only copy of the email keying ALLOWLIST#, and
  // the scrub last because it destroys the rows the earlier steps read.
  it('runs Auth0, Stripe, tenants and the scrub in that order', async () => {
    await handler({ orgId: ORG });

    expect(order).toEqual(['email:auth0|one', 'auth0:auth0|one', 'stripe', 'tenant:42', 'scrub']);
  });

  describe('the allowlist row', () => {
    it('is revoked while Auth0 can still resolve the email that keys it', async () => {
      await handler({ orgId: ORG });

      expect(ddbMock.commandCalls(DeleteItemCommand)[0]!.args[0].input.Key).toEqual({
        pk: { S: 'ALLOWLIST#user@example.com' },
        sk: { S: 'RAG' },
      });
    });

    // A previous pass already deleted the user, so the row is already gone too.
    it('is skipped when the lookup 404s, and the user delete still runs', async () => {
      mockGetAuth0UserEmail.mockResolvedValueOnce(undefined);

      await handler({ orgId: ORG });

      expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
      expect(mockDeleteAuth0User).toHaveBeenCalledWith('auth0|one');
    });
  });

  it('reads the record consistently', async () => {
    await handler({ orgId: ORG });

    expect(ddbMock.commandCalls(GetItemCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  it('counts the pass before doing any work, so the sweeper sees it as live', async () => {
    await handler({ orgId: ORG });

    const first = ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input;
    expect(first.UpdateExpression).toBe('ADD attempts :one SET updatedAt = :now');
  });

  // Re-applied rather than trusted from confirm, so a teardown the sweeper picked
  // up still fences every writer even if a racing upsert rebuilt the profile.
  it('raises the fence again on every pass', async () => {
    await handler({ orgId: ORG });

    const fence = ddbMock
      .commandCalls(UpdateItemCommand)
      .find((c) => c.args[0].input.Key!.sk!.S === 'PROFILE')!.args[0].input;
    expect(fence.UpdateExpression).toBe('SET deleting = :true, updatedAt = :now');
    expect(fence.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('marks the record DONE last', async () => {
    await handler({ orgId: ORG });

    const last = ddbMock.commandCalls(UpdateItemCommand).at(-1)!.args[0].input;
    expect(last.ExpressionAttributeValues![':done']).toEqual({ S: 'DONE' });
  });

  it('is a no-op once the record is DONE', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: record({ status: 'DONE' }) });

    await handler({ orgId: ORG });

    expect(order).toEqual([]);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  // Swallowing either would mark the async invoke successful and the org would
  // never be torn down.
  it('throws on a payload with no orgId', async () => {
    await expect(handler({ orgId: '' })).rejects.toThrow('payload has no orgId');
  });

  it('throws when the record is missing', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(handler({ orgId: ORG })).rejects.toThrow('no DELETION record');
  });

  describe('tenant teardown', () => {
    it('propagates a tenant failure, leaving the record PENDING', async () => {
      const failing = vi.fn(async () => {
        throw new Error('FTH 500');
      });
      mockGetAvailableOrchestrators.mockReturnValue([orchestrator('fth', failing)]);

      await expect(handler({ orgId: ORG })).rejects.toThrow('FTH 500');
      expect(mockScrub).not.toHaveBeenCalled();
      const marked = ddbMock
        .commandCalls(UpdateItemCommand)
        .some((c) => c.args[0].input.ExpressionAttributeValues?.[':done']);
      expect(marked).toBe(false);
    });

    it('skips a tenant whose orchestrator is not registered on this stage', async () => {
      mockResolveTargets.mockResolvedValue({
        members: [{ userId: 'user-1', sub: 'auth0|one' }],
        tenantIds: { forge: 'forge-t-1' },
      });
      mockGetAvailableOrchestrators.mockReturnValue([orchestrator('fth')]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler({ orgId: ORG });
        expect(mockDeleteTenant).not.toHaveBeenCalled();
        expect(order).toContain('scrub');
      } finally {
        warn.mockRestore();
      }
    });
  });
});
