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

// The orchestrator now reads the PROFILE row only for the org name (for Stripe
// metadata sync); tenant resolution moved into the worker.
function orgProfileItem(name?: string) {
  if (!name) return { Item: undefined };
  return { Item: marshall({ name }) };
}

function mockOrgNames(orgIds: string[]) {
  for (const orgId of orgIds) {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      })
      .resolves(orgProfileItem(`Org ${orgId}`));
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
    mockOrgNames(['org-1']);
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    const invokeCalls = lambdaMock.commandCalls(InvokeCommand);
    expect(invokeCalls).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(invokeCalls[0].args[0].input.Payload as Uint8Array).toString(),
    );
    expect(payload.orgId).toBe('org-1');
    // userId comes from the record pk (CUSTOMER#<userId>) — the worker needs it
    // to close out the billing record when self-healing a deleted customer.
    expect(payload.userId).toBe('user-for-org-1');
    expect(payload.orgName).toBe('Org org-1');
    expect(payload.subscriptionId).toBe('sub_org-1');
    // Tenant resolution moved to the worker — no tenant ids in the payload.
    expect(payload.auroraTenantId).toBeUndefined();
    expect(payload.fthTenantId).toBeUndefined();
  });

  it('invokes worker for multiple tenants', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [subscriptionItem('org-1'), subscriptionItem('org-2')],
    });
    mockOrgNames(['org-1', 'org-2']);
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
    mockOrgNames(['org-1', 'org-2']);
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
    mockOrgNames(['org-1', 'org-2']);
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
    mockOrgNames(['shared-org']);
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(
        lambdaMock.commandCalls(InvokeCommand)[0].args[0].input.Payload as Uint8Array,
      ).toString(),
    );
    expect(payload.orgId).toBe('shared-org');
    expect(payload.orgName).toBe('Org shared-org');
  });

  it('invokes worker even when the org has no profile (orgName undefined)', async () => {
    // Tenant resolution moved to the worker, so the orchestrator no longer
    // gates on provisioning state — every active org is handed off.
    ddbMock.on(ScanCommand).resolves({ Items: [subscriptionItem('org-no-profile')] });
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    const invokeCalls = lambdaMock.commandCalls(InvokeCommand);
    expect(invokeCalls).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(invokeCalls[0].args[0].input.Payload as Uint8Array).toString(),
    );
    expect(payload.orgId).toBe('org-no-profile');
    expect(payload.orgName).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Idempotency — running twice
  // -----------------------------------------------------------------------
  describe('idempotency — running twice', () => {
    it('invokes worker twice when orchestrator runs twice for same subscription', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [subscriptionItem('org-1')] });
      mockOrgNames(['org-1']);
      lambdaMock.on(InvokeCommand).resolves({});

      await handler();
      await handler();

      const invokeCalls = lambdaMock.commandCalls(InvokeCommand);
      expect(invokeCalls).toHaveLength(2);
      // Both invocations carry the same payload
      const payloads = invokeCalls.map((c) =>
        JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()),
      );
      expect(payloads[0].orgId).toBe('org-1');
      expect(payloads[1].orgId).toBe('org-1');
      expect(payloads[0].orgName).toBe('Org org-1');
      expect(payloads[1].orgName).toBe('Org org-1');
    });

    it('second run finds no candidates when subscription was canceled between runs', async () => {
      ddbMock
        .on(ScanCommand)
        .resolvesOnce({ Items: [subscriptionItem('org-1')] })
        .resolvesOnce({ Items: [] }); // canceled between runs — filtered out by scan
      mockOrgNames(['org-1']);
      lambdaMock.on(InvokeCommand).resolves({});

      await handler();
      await handler();

      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    });
  });
});
