import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function driftEmissions() {
  return mockReportMetric.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.SubscriptionStatusDrift === 1);
}

function summaryEmission() {
  return mockReportMetric.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => 'SubscriptionDriftCheckScanned' in e);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscription-drift-checker', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockGetTenantStatus.mockReset();
    mockReportMetric.mockReset();
  });

  it('emits summary with zero scanned when billing table is empty', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(driftEmissions()).toHaveLength(0);
    expect(summaryEmission()).toMatchObject({
      SubscriptionDriftCheckScanned: 0,
      SubscriptionDriftCheckSkipped: 0,
      SubscriptionDriftCheckProbeFailed: 0,
    });
    expect(mockGetTenantStatus).not.toHaveBeenCalled();
  });

  it('classifies Aurora ACTIVE as in_sync', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'ACTIVE' });

    await handler();

    expect(driftEmissions()).toHaveLength(1);
    expect(driftEmissions()[0]).toMatchObject({
      classification: 'in_sync',
      orgId: ORG_ID,
    });
  });

  it('classifies Aurora WRITE_LOCKED as drift_write_locked (paid subs are uncapped)', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'WRITE_LOCKED' });

    await handler();

    expect(driftEmissions()[0]).toMatchObject({ classification: 'drift_write_locked' });
  });

  it('classifies Aurora DISABLED as drift_disabled', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });

    await handler();

    expect(driftEmissions()[0]).toMatchObject({ classification: 'drift_disabled' });
  });

  it('classifies Aurora LOCKED as drift_locked', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'LOCKED' });

    await handler();

    expect(driftEmissions()[0]).toMatchObject({ classification: 'drift_locked' });
  });

  it('classifies Aurora 404 as drift_missing', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'not_found' });

    await handler();

    expect(driftEmissions()[0]).toMatchObject({ classification: 'drift_missing' });
  });

  it('counts Aurora transport errors as probe_failed without emitting a per-org drift datapoint', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('boom') });

    await handler();

    expect(driftEmissions()).toHaveLength(0);
    expect(summaryEmission()).toMatchObject({
      SubscriptionDriftCheckScanned: 1,
      SubscriptionDriftCheckProbeFailed: 1,
    });
  });

  it('skips org when auroraTenantId missing or setup incomplete', async () => {
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
    expect(driftEmissions()).toHaveLength(0);
    expect(summaryEmission()).toMatchObject({
      SubscriptionDriftCheckScanned: 1,
      SubscriptionDriftCheckSkipped: 1,
    });
  });

  it('continues processing when one candidate fails', async () => {
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

    expect(driftEmissions()).toHaveLength(1);
    expect(driftEmissions()[0]).toMatchObject({
      classification: 'in_sync',
      orgId: orgId2,
    });
    expect(summaryEmission()).toMatchObject({
      SubscriptionDriftCheckScanned: 2,
      SubscriptionDriftCheckProbeFailed: 1,
    });
  });

  it('handles paginated scan results', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [activeBillingItem()],
        LastEvaluatedKey: { pk: { S: 'cursor' }, sk: { S: 'val' } },
      })
      .resolvesOnce({ Items: [] });
    seedReadyOrg();
    mockGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'ACTIVE' });

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(summaryEmission()).toMatchObject({ SubscriptionDriftCheckScanned: 1 });
  });

  it('ignores records without orgId', async () => {
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
    expect(summaryEmission()).toMatchObject({ SubscriptionDriftCheckScanned: 0 });
  });
});
