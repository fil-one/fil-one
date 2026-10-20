import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { TenantStatus } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
    OrgTable: { name: 'OrgTable' },
  },
}));

// The tenant sync goes through the orchestrator registry (lib/region-helpers.ts
// is left real), so fake orchestrators record every status change.
const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

vi.mock('../lib/org-profile.ts', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { handler, type AccountState } from './account-state-test-helper.ts';
import { fakeOrchestrator, tenantFor, type FakeOrchestrator } from '../test/fake-orchestrator.ts';

const USER_ID = 'any-user';
const ORG_ID = 'any-org';

function billingUpdate() {
  return ddbMock.commandCalls(UpdateItemCommand)[0]?.args[0].input;
}

describe('account-state-test-helper', () => {
  let aurora: FakeOrchestrator;

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves({ Item: { orgId: { S: ORG_ID } } });
    ddbMock.on(QueryCommand, { TableName: 'OrgTable' }).resolves({ Items: [] });
    ddbMock.on(UpdateItemCommand).resolves({});
    aurora = fakeOrchestrator('aurora');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.FILONE_STAGE = 'test';
  });

  it.each([
    { state: 'paid', subscriptionStatus: 'active' },
    { state: 'unpaid', subscriptionStatus: 'past_due' },
    { state: 'trial', subscriptionStatus: 'trialing' },
    { state: 'disabled', subscriptionStatus: 'canceled' },
  ] satisfies Array<{ state: AccountState; subscriptionStatus: string }>)(
    'writes $subscriptionStatus to the org row for state $state',
    async ({ state, subscriptionStatus }) => {
      aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'write-locked' });

      await handler({ userId: USER_ID, state });

      expect(billingUpdate()).toMatchObject({
        TableName: 'BillingTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } },
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':s0': { S: subscriptionStatus } },
      });
    },
  );

  it.each([
    { state: 'paid', tenantStatus: 'active' },
    { state: 'unpaid', tenantStatus: 'active' },
    { state: 'trial', tenantStatus: 'active' },
    { state: 'disabled', tenantStatus: 'disabled' },
  ] satisfies Array<{ state: AccountState; tenantStatus: TenantStatus }>)(
    'sets the tenants to $tenantStatus for state $state',
    async ({ state, tenantStatus }) => {
      // A live status matching neither target, so every state has to update it.
      aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'write-locked' });

      await handler({ userId: USER_ID, state });

      expect(aurora.updateTenantStatus.mock.calls).toStrictEqual([
        [tenantFor('aurora', ORG_ID), tenantStatus],
      ]);
    },
  );

  it.each([
    { state: 'paid', removed: ['gracePeriodEndsAt', 'canceledAt', 'lastPaymentFailedAt'] },
    { state: 'unpaid', removed: ['gracePeriodEndsAt', 'canceledAt'] },
    { state: 'disabled', removed: ['gracePeriodEndsAt', 'canceledAt', 'lastPaymentFailedAt'] },
  ] satisfies Array<{ state: AccountState; removed: string[] }>)(
    'removes the state-specific attributes state $state does not set',
    async ({ state, removed }) => {
      await handler({ userId: USER_ID, state });

      const input = billingUpdate()!;
      const removedNames = input
        .UpdateExpression!.split(' REMOVE ')[1]
        .split(', ')
        .map((placeholder) => input.ExpressionAttributeNames![placeholder]);
      expect(removedNames).toStrictEqual(removed);
    },
  );

  it('returns the org, the status written and each region outcome', async () => {
    aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'active' });

    const result = await handler({ userId: USER_ID, state: 'disabled' });

    expect(result).toStrictEqual({
      orgId: ORG_ID,
      subscriptionStatus: 'canceled',
      regions: [
        { orchestratorId: 'aurora', tenantId: tenantFor('aurora', ORG_ID), outcome: 'updated' },
      ],
    });
  });

  it('disables the tenants before writing canceled', async () => {
    const order = recordOrder();

    await handler({ userId: USER_ID, state: 'disabled' });

    expect(order).toStrictEqual(['tenant', 'row']);
  });

  it('writes the row before re-activating the tenants', async () => {
    aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'disabled' });
    const order = recordOrder();

    await handler({ userId: USER_ID, state: 'paid' });

    expect(order).toStrictEqual(['row', 'tenant']);
  });

  it('rejects when a region fails to disable', async () => {
    vi.useFakeTimers();
    aurora.updateTenantStatus.mockRejectedValue(new Error('any upstream error'));

    const run = expect(handler({ userId: USER_ID, state: 'disabled' })).rejects.toThrow(
      'tenant status sync failed for: aurora',
    );
    await vi.runAllTimersAsync();
    await run;
  });

  it('leaves the row unwritten when a region fails to disable', async () => {
    vi.useFakeTimers();
    aurora.updateTenantStatus.mockRejectedValue(new Error('any upstream error'));

    const run = handler({ userId: USER_ID, state: 'disabled' }).catch(() => {});
    await vi.runAllTimersAsync();
    await run;

    expect(ddbMock.commandCalls(UpdateItemCommand)).toStrictEqual([]);
  });

  it('rejects naming the missing row when the org has no subscription row', async () => {
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    await expect(handler({ userId: USER_ID, state: 'paid' })).rejects.toThrow(
      `no billing row at ORG#${ORG_ID}/SUBSCRIPTION`,
    );
  });

  it('falls back to the first membership when the profile names no org', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UserInfoTable' }).resolves({ Item: {} });
    ddbMock.on(QueryCommand, { TableName: 'OrgTable' }).resolves({
      Items: [
        {
          pk: { S: `USER#${USER_ID}` },
          sk: { S: 'MEMBERSHIP#any-member-org' },
          role: { S: 'owner' },
        },
      ],
    });

    const result = await handler({ userId: USER_ID, state: 'paid' });

    expect(result).toMatchObject({ orgId: 'any-member-org' });
  });

  it('rejects when the profile names no org and the user belongs to none', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UserInfoTable' }).resolves({ Item: undefined });

    await expect(handler({ userId: USER_ID, state: 'paid' })).rejects.toThrow(
      `User ${USER_ID} has no home org`,
    );
  });

  it('refuses to run in production', async () => {
    process.env.FILONE_STAGE = 'production';

    await expect(handler({ userId: USER_ID, state: 'paid' })).rejects.toThrow(
      'Refusing to run in production',
    );
  });

  it.each([
    // No event at all.
    { event: undefined, message: /userId must be a non-empty string/ },
    // userId missing.
    { event: { state: 'paid' }, message: /userId must be a non-empty string/ },
    // userId empty.
    { event: { userId: '', state: 'paid' }, message: /userId must be a non-empty string/ },
    // userId not a string.
    { event: { userId: 42, state: 'paid' }, message: /userId must be a non-empty string/ },
    // state missing.
    { event: { userId: USER_ID }, message: /state must be one of/ },
    // state not one of the four.
    { event: { userId: USER_ID, state: 'grace_period' }, message: /state must be one of/ },
    // An inherited property name, which a plain `in` check would accept.
    { event: { userId: USER_ID, state: 'toString' }, message: /state must be one of/ },
  ])('rejects the invalid event $event', async ({ event, message }) => {
    await expect(handler(event)).rejects.toThrow(message);
  });

  /** Records whether the tenant sync or the row write happened first. */
  function recordOrder(): string[] {
    const order: string[] = [];
    aurora.updateTenantStatus.mockImplementation(async () => {
      order.push('tenant');
    });
    ddbMock.on(UpdateItemCommand).callsFake(() => {
      order.push('row');
      return {};
    });
    return order;
  }
});
