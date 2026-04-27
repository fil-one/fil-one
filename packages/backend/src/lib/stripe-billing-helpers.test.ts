import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockUpdateTenantStatus = vi.fn();
vi.mock('../lib/aurora-backoffice.js', () => ({
  updateTenantStatus: (...args: unknown[]) => mockUpdateTenantStatus(...args),
}));

const mockSetOrgAuroraTenantStatus = vi.fn();
vi.mock('../lib/org-profile.js', () => ({
  setOrgAuroraTenantStatus: (...args: unknown[]) => mockSetOrgAuroraTenantStatus(...args),
}));

vi.mock('../lib/org-setup-status.js', () => ({
  isOrgSetupComplete: (status: string | undefined) => status === 'AURORA_S3_ACCESS_KEY_CREATED',
}));

const mockEmitDunningEscalation = vi.fn();
vi.mock('../lib/stripe-dunning.js', () => ({
  emitDunningEscalation: (...args: unknown[]) => mockEmitDunningEscalation(...args),
  bucketAttempt: (n: number | null | undefined): string => {
    if (!n || n < 1) return 'unknown';
    if (n >= 4) return '4+';
    return String(n);
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  applyCancellationGracePeriod,
  resolveAuroraTenantId,
  resolveUserIdByStripeCustomer,
} from './stripe-billing-helpers.js';

const TABLE_NAME = 'BillingTable';
const USER_ID = 'user-123';
const ORG_ID = 'org-456';
const AURORA_TENANT_ID = 'aurora-tenant-789';
const STRIPE_CUSTOMER_ID = 'cus_ABC123';

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetItemCommand).resolves({ Item: undefined });
  ddbMock.on(UpdateItemCommand).resolves({});
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  mockUpdateTenantStatus.mockReset();
  mockUpdateTenantStatus.mockResolvedValue(undefined);
  mockSetOrgAuroraTenantStatus.mockReset();
  mockSetOrgAuroraTenantStatus.mockResolvedValue(undefined);
  mockEmitDunningEscalation.mockReset();
});

// ---------------------------------------------------------------------------
// resolveAuroraTenantId
// ---------------------------------------------------------------------------

describe('resolveAuroraTenantId', () => {
  function setupBillingRow(orgId: string | undefined) {
    ddbMock
      .on(GetItemCommand, {
        TableName: TABLE_NAME,
        Key: { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
      })
      .resolves(orgId ? { Item: marshall({ orgId }) } : { Item: undefined });
  }

  function setupOrgProfile(item: Record<string, string> | undefined) {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves(item ? { Item: marshall(item) } : { Item: undefined });
  }

  it('returns null and warns when billing record has no orgId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupBillingRow(undefined);

    const result = await resolveAuroraTenantId(USER_ID, TABLE_NAME);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No orgId on billing record'),
      USER_ID,
    );
    warnSpy.mockRestore();
  });

  it('returns null and warns when org profile has no auroraTenantId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupBillingRow(ORG_ID);
    setupOrgProfile({ setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED' });

    const result = await resolveAuroraTenantId(USER_ID, TABLE_NAME);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Aurora tenant not ready'),
      ORG_ID,
    );
    warnSpy.mockRestore();
  });

  it('returns null when setupStatus is not complete', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupBillingRow(ORG_ID);
    setupOrgProfile({ auroraTenantId: AURORA_TENANT_ID, setupStatus: 'PENDING' });

    const result = await resolveAuroraTenantId(USER_ID, TABLE_NAME);

    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it('returns { orgId, auroraTenantId } when both lookups succeed and setup is complete', async () => {
    setupBillingRow(ORG_ID);
    setupOrgProfile({
      auroraTenantId: AURORA_TENANT_ID,
      setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
    });

    const result = await resolveAuroraTenantId(USER_ID, TABLE_NAME);

    expect(result).toEqual({ orgId: ORG_ID, auroraTenantId: AURORA_TENANT_ID });
  });

  it('uses Resource.UserInfoTable.name for the org profile lookup', async () => {
    setupBillingRow(ORG_ID);
    setupOrgProfile({
      auroraTenantId: AURORA_TENANT_ID,
      setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
    });

    await resolveAuroraTenantId(USER_ID, TABLE_NAME);

    const orgGet = ddbMock
      .commandCalls(GetItemCommand)
      .find((c) => c.args[0].input.TableName === 'UserInfoTable');
    expect(orgGet).toBeDefined();
    expect(orgGet!.args[0].input.Key).toEqual({
      pk: { S: `ORG#${ORG_ID}` },
      sk: { S: 'PROFILE' },
    });
  });
});

// ---------------------------------------------------------------------------
// applyCancellationGracePeriod
// ---------------------------------------------------------------------------

describe('applyCancellationGracePeriod', () => {
  function setupResolvedTenant() {
    ddbMock
      .on(GetItemCommand, {
        TableName: TABLE_NAME,
        Key: { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
      })
      .resolves({ Item: marshall({ orgId: ORG_ID }) });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: marshall({
          auroraTenantId: AURORA_TENANT_ID,
          setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
        }),
      });
  }

  it('writes UpdateItem with GracePeriod, ConditionExpression, and grace window', async () => {
    const before = Date.now();
    await applyCancellationGracePeriod({
      tableName: TABLE_NAME,
      userId: USER_ID,
      graceDays: 30,
      cancellationReason: 'unknown',
      attemptCount: undefined,
    });
    const after = Date.now();

    const updates = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((c) => c.args[0].input.TableName === TABLE_NAME);
    expect(updates).toHaveLength(1);

    const input = updates[0].args[0].input;
    expect(input).toMatchObject({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `CUSTOMER#${USER_ID}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionStatus = :status, canceledAt = :now, gracePeriodEndsAt = :grace, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(input.ExpressionAttributeValues![':status']).toEqual({
      S: SubscriptionStatus.GracePeriod,
    });

    const graceMs = new Date(input.ExpressionAttributeValues![':grace'].S!).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(graceMs).toBeGreaterThanOrEqual(before + thirtyDaysMs - 5000);
    expect(graceMs).toBeLessThanOrEqual(after + thirtyDaysMs + 5000);
  });

  it('uses the supplied graceDays for the grace window', async () => {
    const before = Date.now();
    await applyCancellationGracePeriod({
      tableName: TABLE_NAME,
      userId: USER_ID,
      graceDays: 7,
      cancellationReason: 'unknown',
      attemptCount: undefined,
    });
    const after = Date.now();

    const input = ddbMock
      .commandCalls(UpdateItemCommand)
      .find((c) => c.args[0].input.TableName === TABLE_NAME)!.args[0].input;
    const graceMs = new Date(input.ExpressionAttributeValues![':grace'].S!).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(graceMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 5000);
    expect(graceMs).toBeLessThanOrEqual(after + sevenDaysMs + 5000);
  });

  it('warns and returns early on ConditionalCheckFailedException — no metric, no Aurora', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const condError = new Error('Conditional check failed');
    (condError as { name: string }).name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateItemCommand, { TableName: TABLE_NAME }).rejects(condError);

    await applyCancellationGracePeriod({
      tableName: TABLE_NAME,
      userId: USER_ID,
      graceDays: 30,
      cancellationReason: 'customer_deleted',
      attemptCount: undefined,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No billing row to update for cancellation'),
      expect.objectContaining({ userId: USER_ID, cancellationReason: 'customer_deleted' }),
    );
    expect(mockEmitDunningEscalation).not.toHaveBeenCalled();
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rethrows non-condition errors from UpdateItem', async () => {
    ddbMock.on(UpdateItemCommand, { TableName: TABLE_NAME }).rejects(new Error('boom'));

    await expect(
      applyCancellationGracePeriod({
        tableName: TABLE_NAME,
        userId: USER_ID,
        graceDays: 30,
        cancellationReason: 'unknown',
        attemptCount: undefined,
      }),
    ).rejects.toThrow('boom');
  });

  it('emits dunning canceled metric with reason and bucketed attemptCount', async () => {
    await applyCancellationGracePeriod({
      tableName: TABLE_NAME,
      userId: USER_ID,
      graceDays: 30,
      cancellationReason: 'payment_failed',
      attemptCount: 5,
    });

    expect(mockEmitDunningEscalation).toHaveBeenCalledWith({
      stage: 'canceled',
      reason: 'payment_failed',
      attemptBucket: '4+',
    });
  });

  it('WRITE_LOCKs Aurora when the tenant resolves', async () => {
    setupResolvedTenant();

    await applyCancellationGracePeriod({
      tableName: TABLE_NAME,
      userId: USER_ID,
      graceDays: 30,
      cancellationReason: 'unknown',
      attemptCount: undefined,
    });

    expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
      tenantId: AURORA_TENANT_ID,
      status: 'WRITE_LOCKED',
    });
    expect(mockSetOrgAuroraTenantStatus).toHaveBeenCalledWith(ORG_ID, 'WRITE_LOCKED');
  });

  it('does not throw when Aurora WRITE_LOCK fails', async () => {
    setupResolvedTenant();
    mockUpdateTenantStatus.mockRejectedValueOnce(new Error('Aurora down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      applyCancellationGracePeriod({
        tableName: TABLE_NAME,
        userId: USER_ID,
        graceDays: 30,
        cancellationReason: 'unknown',
        attemptCount: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to WRITE_LOCK Aurora tenant'),
      expect.objectContaining({ userId: USER_ID }),
    );
    errorSpy.mockRestore();
  });

  it('skips Aurora when resolveAuroraTenantId returns null (no orgId)', async () => {
    // default GetItem mock returns Item: undefined → no orgId → resolveAuroraTenantId returns null
    await applyCancellationGracePeriod({
      tableName: TABLE_NAME,
      userId: USER_ID,
      graceDays: 30,
      cancellationReason: 'unknown',
      attemptCount: undefined,
    });

    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
    expect(mockSetOrgAuroraTenantStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveUserIdByStripeCustomer
// ---------------------------------------------------------------------------

describe('resolveUserIdByStripeCustomer', () => {
  it('returns userId from the matching billing row', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall({
          pk: `CUSTOMER#${USER_ID}`,
          sk: 'SUBSCRIPTION',
          stripeCustomerId: STRIPE_CUSTOMER_ID,
        }),
      ],
    });

    const result = await resolveUserIdByStripeCustomer(TABLE_NAME, STRIPE_CUSTOMER_ID);

    expect(result).toBe(USER_ID);
  });

  it('issues Scan with sk + stripeCustomerId filter', async () => {
    await resolveUserIdByStripeCustomer(TABLE_NAME, STRIPE_CUSTOMER_ID);

    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans).toHaveLength(1);
    expect(scans[0].args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      FilterExpression: 'sk = :sk AND stripeCustomerId = :sid',
      ExpressionAttributeValues: {
        ':sk': { S: 'SUBSCRIPTION' },
        ':sid': { S: STRIPE_CUSTOMER_ID },
      },
    });
  });

  it('returns undefined when no row matches', async () => {
    const result = await resolveUserIdByStripeCustomer(TABLE_NAME, STRIPE_CUSTOMER_ID);
    expect(result).toBeUndefined();
  });

  it('paginates through LastEvaluatedKey until a match is found', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: { pk: { S: 'CUSTOMER#other-1' } } })
      .resolvesOnce({ Items: [], LastEvaluatedKey: { pk: { S: 'CUSTOMER#other-2' } } })
      .resolvesOnce({
        Items: [
          marshall({
            pk: `CUSTOMER#${USER_ID}`,
            sk: 'SUBSCRIPTION',
            stripeCustomerId: STRIPE_CUSTOMER_ID,
          }),
        ],
      });

    const result = await resolveUserIdByStripeCustomer(TABLE_NAME, STRIPE_CUSTOMER_ID);

    expect(result).toBe(USER_ID);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(3);

    // Second and third scan must carry ExclusiveStartKey from the previous LastEvaluatedKey
    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans[1].args[0].input.ExclusiveStartKey).toEqual({ pk: { S: 'CUSTOMER#other-1' } });
    expect(scans[2].args[0].input.ExclusiveStartKey).toEqual({ pk: { S: 'CUSTOMER#other-2' } });
  });

  it('returns undefined after exhausting all pages without a match', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: { pk: { S: 'CUSTOMER#x' } } })
      .resolvesOnce({ Items: [] });

    const result = await resolveUserIdByStripeCustomer(TABLE_NAME, STRIPE_CUSTOMER_ID);

    expect(result).toBeUndefined();
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });
});
