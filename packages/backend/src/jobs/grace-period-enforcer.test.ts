import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

vi.mock('../lib/org-setup-status.js', () => ({
  isOrgSetupComplete: (status: string | undefined) => status === 'AURORA_S3_ACCESS_KEY_CREATED',
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './grace-period-enforcer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER_ID = 'user-123';
const MOCK_ORG_ID = 'org-456';
const MOCK_AURORA_TENANT_ID = 'aurora-tenant-789';

function pastDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function buildBillingItem(overrides: Record<string, unknown>) {
  return marshall({
    pk: `CUSTOMER#${MOCK_USER_ID}`,
    sk: 'SUBSCRIPTION',
    orgId: MOCK_ORG_ID,
    ...overrides,
  });
}

function setupOrgProfile(extra?: Record<string, string>) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: marshall({
        pk: `ORG#${MOCK_ORG_ID}`,
        sk: 'PROFILE',
        auroraTenantId: MOCK_AURORA_TENANT_ID,
        setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
        ...extra,
      }),
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('grace-period-enforcer', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockUpdateTenantStatus.mockReset();
    mockUpdateTenantStatus.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // No-op
  // -----------------------------------------------------------------------
  it('does nothing when no records found', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Expired grace_period → canceled + DISABLED
  // -----------------------------------------------------------------------
  it('transitions expired grace_period to canceled and DISABLEs Aurora tenant', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });
    setupOrgProfile();

    await handler();

    // DynamoDB: status → canceled
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const cancelCall = updateCalls.find(
      (c) =>
        c.args[0].input.ExpressionAttributeValues?.[':status']?.S === SubscriptionStatus.Canceled,
    );
    expect(cancelCall).toBeDefined();

    // Aurora: DISABLED
    expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
      tenantId: MOCK_AURORA_TENANT_ID,
      status: 'DISABLED',
    });

    // Org profile: auroraTenantStatus = DISABLED
    const orgProfileUpdate = updateCalls.find(
      (c) =>
        c.args[0].input.TableName === 'UserInfoTable' &&
        c.args[0].input.ExpressionAttributeValues?.[':s']?.S === 'DISABLED',
    );
    expect(orgProfileUpdate).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Non-expired grace_period → WRITE_LOCK retry
  // -----------------------------------------------------------------------
  it('retries WRITE_LOCK for non-expired grace_period when auroraTenantStatus is not set', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });
    setupOrgProfile(); // no auroraTenantStatus field

    await handler();

    expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
      tenantId: MOCK_AURORA_TENANT_ID,
      status: 'WRITE_LOCKED',
    });

    // Org profile: auroraTenantStatus = WRITE_LOCKED
    const orgProfileUpdate = ddbMock
      .commandCalls(UpdateItemCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === 'UserInfoTable' &&
          c.args[0].input.ExpressionAttributeValues?.[':s']?.S === 'WRITE_LOCKED',
      );
    expect(orgProfileUpdate).toBeDefined();
  });

  it('skips WRITE_LOCK when auroraTenantStatus is already WRITE_LOCKED', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });
    setupOrgProfile({ auroraTenantStatus: 'WRITE_LOCKED' });

    await handler();

    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
    // No org profile update needed
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Resilience
  // -----------------------------------------------------------------------
  it('continues processing other records when one fails', async () => {
    const userId2 = 'user-second';
    const orgId2 = 'org-second';
    const tenantId2 = 'aurora-tenant-second';

    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
        marshall({
          pk: `CUSTOMER#${userId2}`,
          sk: 'SUBSCRIPTION',
          orgId: orgId2,
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(2),
        }),
      ],
    });

    // First record: DynamoDB update fails
    ddbMock
      .on(UpdateItemCommand, {
        Key: { pk: { S: `CUSTOMER#${MOCK_USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
      })
      .rejects(new Error('DynamoDB error'));

    // Second record: succeeds
    ddbMock
      .on(UpdateItemCommand, {
        Key: { pk: { S: `CUSTOMER#${userId2}` }, sk: { S: 'SUBSCRIPTION' } },
      })
      .resolves({});

    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${orgId2}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: marshall({
          pk: `ORG#${orgId2}`,
          sk: 'PROFILE',
          auroraTenantId: tenantId2,
          setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
        }),
      });

    await handler();

    // Second record should still be processed
    expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
      tenantId: tenantId2,
      status: 'DISABLED',
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  it('skips Aurora calls when org setup is not complete', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: marshall({
          pk: `ORG#${MOCK_ORG_ID}`,
          sk: 'PROFILE',
          auroraTenantId: MOCK_AURORA_TENANT_ID,
          setupStatus: 'AURORA_TENANT_CREATED',
        }),
      });

    await handler();

    // DynamoDB cancel should still happen
    const cancelCall = ddbMock
      .commandCalls(UpdateItemCommand)
      .find(
        (c) =>
          c.args[0].input.ExpressionAttributeValues?.[':status']?.S === SubscriptionStatus.Canceled,
      );
    expect(cancelCall).toBeUndefined();
    // But Aurora should NOT be called
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
  });

  it('skips records with missing orgId', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall({
          pk: `CUSTOMER#${MOCK_USER_ID}`,
          sk: 'SUBSCRIPTION',
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    await handler();

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
  });

  it('handles paginated scan results', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          buildBillingItem({
            subscriptionStatus: SubscriptionStatus.GracePeriod,
            gracePeriodEndsAt: pastDate(1),
          }),
        ],
        LastEvaluatedKey: { pk: { S: 'cursor' }, sk: { S: 'val' } },
      })
      .resolvesOnce({ Items: [] });
    setupOrgProfile();

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(mockUpdateTenantStatus).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Idempotency — running twice
  // -----------------------------------------------------------------------
  describe('idempotency — running twice', () => {
    it('expired grace period — second run finds no candidates after first run canceled', async () => {
      // First scan: record has grace_period status. Second scan: record is now
      // 'canceled' (set by first run), so the FilterExpression excludes it.
      ddbMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [
            buildBillingItem({
              subscriptionStatus: SubscriptionStatus.GracePeriod,
              gracePeriodEndsAt: pastDate(1),
            }),
          ],
        })
        .resolvesOnce({ Items: [] });
      setupOrgProfile();

      await handler();
      await handler();

      // Aurora DISABLED called only on first run
      expect(mockUpdateTenantStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: MOCK_AURORA_TENANT_ID,
        status: 'DISABLED',
      });

      // UpdateItemCommands: 2 from first run (setOrgAuroraTenantStatus + subscription cancel), 0 from second
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(2);
    });

    it('non-expired grace period — second run skips write_lock when already WRITE_LOCKED', async () => {
      // Both scans return the same grace_period item (write_lock doesn't change subscriptionStatus)
      ddbMock.on(ScanCommand).resolves({
        Items: [
          buildBillingItem({
            subscriptionStatus: SubscriptionStatus.GracePeriod,
            gracePeriodEndsAt: futureDate(5),
          }),
        ],
      });

      // First run: profile has no auroraTenantStatus → triggers WRITE_LOCK
      // Second run: profile shows WRITE_LOCKED (set by first run) → skipped
      ddbMock
        .on(GetItemCommand, {
          TableName: 'UserInfoTable',
          Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
        })
        .resolvesOnce({
          Item: marshall({
            auroraTenantId: MOCK_AURORA_TENANT_ID,
            setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
          }),
        })
        .resolvesOnce({
          Item: marshall({
            auroraTenantId: MOCK_AURORA_TENANT_ID,
            setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
            auroraTenantStatus: 'WRITE_LOCKED',
          }),
        });

      await handler();
      await handler();

      // Aurora called only on first run
      expect(mockUpdateTenantStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: MOCK_AURORA_TENANT_ID,
        status: 'WRITE_LOCKED',
      });

      // Only 1 UpdateItemCommand from first run's setOrgAuroraTenantStatus; second run skips entirely
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });
  });
});
