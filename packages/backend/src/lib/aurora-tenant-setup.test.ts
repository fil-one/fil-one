import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockCreateAuroraTenant = vi.fn();
const mockSetupAuroraTenant = vi.fn();

vi.mock('./aurora-backoffice.js', () => ({
  createAuroraTenant: (...args: unknown[]) => mockCreateAuroraTenant(...args),
  setupAuroraTenant: (...args: unknown[]) => mockSetupAuroraTenant(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { processTenantSetup, OrgSetupStatus } from './aurora-tenant-setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function orgProfileItem(overrides: Record<string, { S: string }>) {
  return {
    Item: {
      pk: { S: 'ORG#org-1' },
      sk: { S: 'PROFILE' },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processTenantSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('is a no-op when setupStatus is AURORA_TENANT_SETUP_COMPLETE', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({ setupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE } }),
    );

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('creates tenant and runs setup when status is HYPERSPACE_ORG_CREATED', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({ setupStatus: { S: OrgSetupStatus.HYPERSPACE_ORG_CREATED } }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-1' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-1', lastSetupStep: 'FINISHED' });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).toHaveBeenCalledWith({
      orgId: 'org-1',
      displayName: 'Test Org',
    });

    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-1' });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(2);

    // First update: set auroraTenantId + AURORA_TENANT_CREATED
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'SET auroraTenantId = :tid, setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(setupStatus) OR setupStatus = :expected',
      ExpressionAttributeValues: {
        ':tid': { S: 'aurora-t-1' },
        ':status': { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        ':expected': { S: OrgSetupStatus.HYPERSPACE_ORG_CREATED },
        ':now': { S: expect.any(String) },
      },
    });

    // Second update: set AURORA_TENANT_SETUP_COMPLETE
    expect(updateCalls[1].args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'SET setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'setupStatus = :expected',
      ExpressionAttributeValues: {
        ':status': { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        ':expected': { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        ':now': { S: expect.any(String) },
      },
    });
  });

  it('runs only setup when status is AURORA_TENANT_CREATED', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        auroraTenantId: { S: 'aurora-t-2' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-2', lastSetupStep: 'FINISHED' });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-2' });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE,
    });
  });

  it('throws when setup lastSetupStep is not FINISHED', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        auroraTenantId: { S: 'aurora-t-3' },
      }),
    );
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-3', lastSetupStep: 'WARM_TIER_ADDED' });

    await expect(
      processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' }),
    ).rejects.toThrow('Aurora tenant setup not finished for org org-1: lastSetupStep=WARM_TIER_ADDED');
  });

  it('creates tenant and runs setup when setupStatus is undefined (pre-existing org)', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileItem({}));
    ddbMock.on(UpdateItemCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-new' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-new', lastSetupStep: 'FINISHED' });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).toHaveBeenCalledWith({
      orgId: 'org-1',
      displayName: 'Test Org',
    });
    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-new' });
  });

  it('throws when org profile is not found', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(
      processTenantSetup({ orgId: 'org-missing', orgName: 'Missing Org' }),
    ).rejects.toThrow('Org profile not found for org org-missing');
  });
});
