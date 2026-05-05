import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
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

const mockGetTenantStatus = vi.fn();
vi.mock('../lib/aurora-backoffice.js', () => ({
  getTenantStatus: (...args: unknown[]) => mockGetTenantStatus(...args),
}));

vi.mock('../lib/org-setup-status.js', () => ({
  isOrgSetupComplete: (status: string | undefined) => status === 'AURORA_S3_ACCESS_KEY_CREATED',
}));

const mockReportMetric = vi.fn();
vi.mock('../lib/metrics.js', () => ({
  reportMetric: (...args: unknown[]) => mockReportMetric(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './subscription-drift-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-abc';
const ORG_ID = 'org-xyz';
const TENANT_ID = 'tenant-123';

function activeBillingItem(orgId = ORG_ID, userId = USER_ID) {
  return marshall({
    pk: `CUSTOMER#${userId}`,
    sk: 'SUBSCRIPTION',
    orgId,
    subscriptionStatus: SubscriptionStatus.Active,
  });
}

function seedReadyOrg(orgId = ORG_ID, tenantId = TENANT_ID) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: marshall({
        auroraTenantId: tenantId,
        setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
      }),
    });
}

function summaryEmission() {
  return mockReportMetric.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => 'SubscriptionsNotInSync' in e);
}

function outOfSyncLogs(spy: ReturnType<typeof vi.spyOn>) {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls.filter((c) => c[0] === '[subscription-drift-checker] out_of_sync');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscription-drift-checker', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockGetTenantStatus.mockReset();
    mockReportMetric.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits zero counters when billing table is empty', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 0,
    });
    expect(mockGetTenantStatus).not.toHaveBeenCalled();
    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
  });

  it('emits no out_of_sync log when Aurora reports ACTIVE', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'ACTIVE' });

    await handler();

    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 0,
    });
  });

  it.each([
    ['WRITE_LOCKED', { kind: 'ok', status: 'WRITE_LOCKED' }, 'WRITE_LOCKED'],
    ['LOCKED', { kind: 'ok', status: 'LOCKED' }, 'LOCKED'],
    ['DISABLED', { kind: 'ok', status: 'DISABLED' }, 'DISABLED'],
    ['not_found', { kind: 'not_found' }, 'not_found'],
  ])(
    'logs out_of_sync and increments counter when Aurora reports %s',
    async (_label, tenantStatus, expectedAuroraStatus) => {
      ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
      seedReadyOrg();
      mockGetTenantStatus.mockResolvedValue(tenantStatus);

      await handler();

      const logs = outOfSyncLogs(logSpy);
      expect(logs).toHaveLength(1);
      expect(logs[0][1]).toMatchObject({
        orgId: ORG_ID,
        userId: USER_ID,
        auroraTenantId: TENANT_ID,
        auroraStatus: expectedAuroraStatus,
      });
      expect(summaryEmission()).toMatchObject({
        SubscriptionsNotInSync: 1,
        SubscriptionsMissingTenant: 0,
        SubscriptionsProbeFailed: 0,
      });
    },
  );

  it('counts probe failures when Aurora returns transport errors', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('boom') });

    await handler();

    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 1,
    });
  });

  it('counts org as missing tenant when auroraTenantId missing or setup incomplete', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: marshall({
          auroraTenantId: TENANT_ID,
          setupStatus: 'AURORA_TENANT_CREATED', // not final
        }),
      });

    await handler();

    expect(mockGetTenantStatus).not.toHaveBeenCalled();
    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 1,
      SubscriptionsProbeFailed: 0,
    });
  });

  it('counts probe failure when getTenantStatus throws and continues processing', async () => {
    const orgId2 = 'org-second';
    const tenantId2 = 'tenant-second';

    ddbMock.on(ScanCommand).resolves({
      Items: [activeBillingItem(), activeBillingItem(orgId2, 'user-second')],
    });
    seedReadyOrg();
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${orgId2}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: marshall({
          auroraTenantId: tenantId2,
          setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
        }),
      });

    mockGetTenantStatus
      .mockImplementationOnce(() => {
        throw new Error('transient');
      })
      .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' });

    await handler();

    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 1,
    });
  });

  it('dedupes multiple billing records for the same orgId and probes Aurora once', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        activeBillingItem(ORG_ID, 'user-first'),
        activeBillingItem(ORG_ID, 'user-second'),
        activeBillingItem(ORG_ID, 'user-third'),
      ],
    });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });

    await handler();

    expect(mockGetTenantStatus).toHaveBeenCalledTimes(1);
    const logs = outOfSyncLogs(logSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({
      orgId: ORG_ID,
      userId: 'user-first', // first-seen userId becomes the representative
      auroraStatus: 'DISABLED',
    });
    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 1,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 0,
    });
  });

  it('handles paginated scan results', async () => {
    const orgIdPage2 = 'org-page2';
    const tenantIdPage2 = 'tenant-page2';

    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [activeBillingItem()],
        LastEvaluatedKey: { pk: { S: 'cursor' }, sk: { S: 'val' } },
      })
      .resolvesOnce({ Items: [activeBillingItem(orgIdPage2, 'user-page2')] });
    seedReadyOrg();
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${orgIdPage2}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({
        Item: marshall({
          auroraTenantId: tenantIdPage2,
          setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
        }),
      });

    mockGetTenantStatus
      .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
      .mockResolvedValueOnce({ kind: 'ok', status: 'WRITE_LOCKED' });

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    const logs = outOfSyncLogs(logSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ orgId: orgIdPage2 });
    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 1,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 0,
    });
  });

  it('logs an error and skips records without orgId', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall({
          pk: `CUSTOMER#${USER_ID}`,
          sk: 'SUBSCRIPTION',
          subscriptionStatus: SubscriptionStatus.Active,
        }),
      ],
    });

    await handler();

    expect(mockGetTenantStatus).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[subscription-drift-checker] missing orgId',
      expect.objectContaining({ pk: `CUSTOMER#${USER_ID}` }),
    );
    expect(summaryEmission()).toMatchObject({
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 0,
    });
  });
});
