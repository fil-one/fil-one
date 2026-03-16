import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

vi.stubEnv('USAGE_WORKER_FUNCTION_NAME', 'usage-worker-fn');

const ddbMock = mockClient(DynamoDBClient);
const lambdaMock = mockClient(LambdaClient);

import { handler } from './usage-reporting-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subscriptionItem(orgId: string, extra: Record<string, unknown> = {}) {
  return marshall(
    {
      pk: `CUSTOMER#user-for-${orgId}`,
      sk: 'SUBSCRIPTION',
      orgId,
      subscriptionId: `sub_${orgId}`,
      stripeCustomerId: `cus_${orgId}`,
      subscriptionStatus: 'active',
      currentPeriodStart: '2024-01-01T00:00:00Z',
      ...extra,
    },
    { removeUndefinedValues: true },
  );
}

function orgProfileItem(orgId: string, auroraTenantId?: string) {
  if (!auroraTenantId) return { Item: undefined };
  return {
    Item: marshall({ auroraTenantId }),
  };
}

function mockGetItemForOrgs(orgIds: string[], auroraTenantIdPrefix = 'aurora-') {
  for (const orgId of orgIds) {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      })
      .resolves(orgProfileItem(orgId, `${auroraTenantIdPrefix}${orgId}`));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usage-reporting-orchestrator', () => {
  beforeEach(() => {
    ddbMock.reset();
    lambdaMock.reset();
    vi.clearAllMocks();
  });

  it('does nothing when no active subscriptions', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('invokes worker for a single tenant', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionItem('org-1')] });
    mockGetItemForOrgs(['org-1']);
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    const invokeCalls = lambdaMock.commandCalls(InvokeCommand);
    expect(invokeCalls).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(invokeCalls[0].args[0].input.Payload as Uint8Array).toString(),
    );
    expect(payload.orgId).toBe('org-1');
    expect(payload.auroraTenantId).toBe('aurora-org-1');
    expect(payload.subscriptionId).toBe('sub_org-1');
  });

  it('invokes worker for multiple tenants', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionItem('org-1'), subscriptionItem('org-2')],
    });
    mockGetItemForOrgs(['org-1', 'org-2']);
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
  });

  it('handles paginated scan', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [subscriptionItem('org-1')],
        LastEvaluatedKey: marshall({ pk: 'CUSTOMER#user-1', sk: 'SUBSCRIPTION' }),
      })
      .resolvesOnce({
        Items: [subscriptionItem('org-2')],
      });
    mockGetItemForOrgs(['org-1', 'org-2']);
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
  });

  it('skips tenant with missing orgId', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionItem('org-1', { orgId: undefined })],
    });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('skips tenant with missing currentPeriodStart', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionItem('org-1', { currentPeriodStart: undefined })],
    });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('continues when one Lambda invoke fails', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionItem('org-1'), subscriptionItem('org-2')],
    });
    mockGetItemForOrgs(['org-1', 'org-2']);
    lambdaMock.on(InvokeCommand).rejectsOnce(new Error('invoke failed')).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
  });

  it('deduplicates by orgId — two records same org = one worker invocation', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        subscriptionItem('shared-org', {
          pk: 'CUSTOMER#user-1',
          subscriptionId: 'sub_1',
          stripeCustomerId: 'cus_1',
        }),
        subscriptionItem('shared-org', {
          pk: 'CUSTOMER#user-2',
          subscriptionId: 'sub_2',
          stripeCustomerId: 'cus_2',
        }),
      ],
    });
    mockGetItemForOrgs(['shared-org']);
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(
        lambdaMock.commandCalls(InvokeCommand)[0].args[0].input.Payload as Uint8Array,
      ).toString(),
    );
    expect(payload.orgId).toBe('shared-org');
    expect(payload.auroraTenantId).toBe('aurora-shared-org');
  });

  it('skips org when auroraTenantId is missing', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionItem('org-no-tenant')],
    });
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('skips org with empty profile (no auroraTenantId attribute)', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionItem('org-1'), subscriptionItem('org-2')],
    });
    // org-1 has no auroraTenantId, org-2 does
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: marshall({ pk: 'ORG#org-1', sk: 'PROFILE' }) })
      .resolvesOnce(orgProfileItem('org-2', 'aurora-org-2'));
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(
        lambdaMock.commandCalls(InvokeCommand)[0].args[0].input.Payload as Uint8Array,
      ).toString(),
    );
    expect(payload.orgId).toBe('org-2');
    expect(payload.auroraTenantId).toBe('aurora-org-2');
  });
});
