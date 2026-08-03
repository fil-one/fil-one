import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

const mockSyncTenantStatusInProvisionedRegions = vi.hoisted(() => vi.fn());
vi.mock('./region-helpers.js', () => ({
  syncTenantStatusInProvisionedRegions: (...args: unknown[]) =>
    mockSyncTenantStatusInProvisionedRegions(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  closeOutDeletedCustomer,
  resolveOrgIdFromSubscription,
} from './deleted-customer-cleanup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE_NAME = 'BillingTable';
const USER_ID = 'user-1';
const ORG_ID = 'org-1';

function okOutcome(orchestratorId: string) {
  return { orchestratorId, tenantId: `${orchestratorId}-tenant`, outcome: 'updated' as const };
}

function errorOutcome(orchestratorId: string) {
  return {
    orchestratorId,
    tenantId: `${orchestratorId}-tenant`,
    outcome: 'error' as const,
    cause: new Error('region down'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('closeOutDeletedCustomer', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSyncTenantStatusInProvisionedRegions.mockReset();
    mockSyncTenantStatusInProvisionedRegions.mockResolvedValue([okOutcome('aurora')]);
  });

  it('disables tenants, then marks the billing record canceled', async () => {
    const outcomes = await closeOutDeletedCustomer({
      userId: USER_ID,
      orgId: ORG_ID,
    });

    expect(mockSyncTenantStatusInProvisionedRegions).toHaveBeenCalledWith(
      ORG_ID,
      'disabled',
      undefined,
    );

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `CUSTOMER#${USER_ID}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionStatus = :status, canceledAt = :now, updatedAt = :now REMOVE gracePeriodEndsAt',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.Canceled },
        ':now': { S: expect.any(String) },
      },
      ConditionExpression: 'attribute_exists(pk)',
    });

    expect(outcomes).toEqual([okOutcome('aurora')]);
  });

  it('passes the retry options through to the region sync', async () => {
    const retry = { retries: 1, minTimeout: 200 };

    await closeOutDeletedCustomer({
      userId: USER_ID,
      orgId: ORG_ID,
      retry,
    });

    expect(mockSyncTenantStatusInProvisionedRegions).toHaveBeenCalledWith(
      ORG_ID,
      'disabled',
      retry,
    );
  });

  it('leaves the billing record untouched when any region fails to sync', async () => {
    mockSyncTenantStatusInProvisionedRegions.mockResolvedValue([
      okOutcome('aurora'),
      errorOutcome('fth'),
    ]);

    const outcomes = await closeOutDeletedCustomer({
      userId: USER_ID,
      orgId: ORG_ID,
    });

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(outcomes).toEqual([okOutcome('aurora'), errorOutcome('fth')]);
  });

  it('cancels the record without any region sync when orgId is null, with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcomes = await closeOutDeletedCustomer({
      userId: USER_ID,
      orgId: null,
    });

    expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    expect(outcomes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No orgId — skipping tenant status sync'),
      expect.objectContaining({ userId: USER_ID }),
    );
    warnSpy.mockRestore();
  });

  it('tolerates a missing billing record (conditional check failure)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conditionalFailure = new Error('The conditional request failed');
    conditionalFailure.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateItemCommand).rejects(conditionalFailure);

    await expect(closeOutDeletedCustomer({ userId: USER_ID, orgId: ORG_ID })).resolves.toEqual([
      okOutcome('aurora'),
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No billing record to cancel'),
      expect.objectContaining({ userId: USER_ID }),
    );
    warnSpy.mockRestore();
  });

  it('propagates other DynamoDB errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(closeOutDeletedCustomer({ userId: USER_ID, orgId: ORG_ID })).rejects.toThrow(
      'throttled',
    );
  });
});

describe('resolveOrgIdFromSubscription', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('returns the orgId from the billing record', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({ pk: `CUSTOMER#${USER_ID}`, sk: 'SUBSCRIPTION', orgId: ORG_ID }),
    });

    await expect(resolveOrgIdFromSubscription(USER_ID)).resolves.toBe(ORG_ID);

    const getCalls = ddbMock.commandCalls(GetItemCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input.Key).toEqual({
      pk: { S: `CUSTOMER#${USER_ID}` },
      sk: { S: 'SUBSCRIPTION' },
    });
  });

  it('returns null when the record or orgId is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(resolveOrgIdFromSubscription(USER_ID)).resolves.toBeNull();
    warnSpy.mockRestore();
  });
});
