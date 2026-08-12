import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const order: string[] = [];
const mockTearDownStripe = vi.fn(async () => void order.push('stripe'));
const mockPurge = vi.fn(async () => void order.push('purge'));
const mockDeleteAuth0User = vi.fn(async (sub: string) => void order.push(`auth0:${sub}`));
const mockDeleteTenant = vi.fn(async (tenantId: string) => void order.push(`tenant:${tenantId}`));

vi.mock('../lib/deletion-stripe-teardown.js', () => ({
  tearDownStripe: () => mockTearDownStripe(),
}));
vi.mock('../lib/deletion-purge.js', () => ({ purgeOrgRecords: () => mockPurge() }));
vi.mock('../lib/auth0-management.js', () => ({
  deleteAuth0User: (sub: string) => mockDeleteAuth0User(sub),
}));

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: () => mockGetAvailableOrchestrators(),
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './account-deletion-worker.js';
import { NotImplementedError } from '../lib/errors.js';

const ORG = 'org-1';

function record(over: Record<string, unknown> = {}) {
  return marshall({
    pk: `ORG#${ORG}`,
    sk: 'DELETION',
    status: 'PENDING',
    requestedAt: '2026-08-12T10:00:00.000Z',
    requestedByUserId: 'user-1',
    members: [{ userId: 'user-1', sub: 'auth0|one' }],
    tenantIds: { fth: '42' },
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
    mockGetAvailableOrchestrators.mockReturnValue([orchestrator('fth')]);
  });

  // Stripe first because it is the only thing still costing money; our own rows
  // last because they are the only route to the tenant ids and customers.
  it('runs Stripe, tenants, purge and Auth0 in that order', async () => {
    await handler({ orgId: ORG });

    expect(order).toEqual(['stripe', 'tenant:42', 'purge', 'auth0:auth0|one']);
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
    // Letting NotImplementedError through would block the purge and re-drive
    // forever for every Aurora org.
    it('skips a provider that cannot delete tenants, and still purges', async () => {
      const failing = vi.fn(async () => {
        throw new NotImplementedError('Aurora tenant deletion is not yet supported.');
      });
      ddbMock
        .on(GetItemCommand)
        .resolves({ Item: record({ tenantIds: { aurora: 'aurora-t-1' } }) });
      mockGetAvailableOrchestrators.mockReturnValue([orchestrator('aurora', failing)]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handler({ orgId: ORG });
        expect(order).toEqual(['stripe', 'purge', 'auth0:auth0|one']);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('customer data survives upstream'),
          expect.objectContaining({ orchestratorId: 'aurora' }),
        );
      } finally {
        error.mockRestore();
      }
    });

    it('propagates any other tenant failure, leaving the record PENDING', async () => {
      const failing = vi.fn(async () => {
        throw new Error('FTH 500');
      });
      mockGetAvailableOrchestrators.mockReturnValue([orchestrator('fth', failing)]);

      await expect(handler({ orgId: ORG })).rejects.toThrow('FTH 500');
      expect(mockPurge).not.toHaveBeenCalled();
      const marked = ddbMock
        .commandCalls(UpdateItemCommand)
        .some((c) => c.args[0].input.ExpressionAttributeValues?.[':done']);
      expect(marked).toBe(false);
    });

    it('skips a tenant whose orchestrator is not registered on this stage', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: record({ tenantIds: { forge: 'forge-t-1' } }) });
      mockGetAvailableOrchestrators.mockReturnValue([orchestrator('fth')]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler({ orgId: ORG });
        expect(mockDeleteTenant).not.toHaveBeenCalled();
        expect(order).toContain('purge');
      } finally {
        warn.mockRestore();
      }
    });
  });
});
