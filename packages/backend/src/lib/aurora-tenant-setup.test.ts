import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

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
const mockCreateAuroraTenantApiKey = vi.fn();

vi.mock('./aurora-backoffice.js', () => ({
  createAuroraTenant: (...args: unknown[]) => mockCreateAuroraTenant(...args),
  setupAuroraTenant: (...args: unknown[]) => mockSetupAuroraTenant(...args),
  createAuroraTenantApiKey: (...args: unknown[]) => mockCreateAuroraTenantApiKey(...args),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);

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
    ssmMock.reset();
  });

  it('is a no-op when setupStatus is AURORA_TENANT_API_KEY_CREATED', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(
        orgProfileItem({ setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED } }),
      );

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).not.toHaveBeenCalled();
    expect(mockCreateAuroraTenantApiKey).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('creates tenant, runs setup, and creates API key when status is FILONE_ORG_CREATED', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(orgProfileItem({ setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED } }));
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-1' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-1', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_secret', tokenId: 'tok-1' });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).toHaveBeenCalledWith({
      orgId: 'org-1',
      displayName: 'Test Org',
    });

    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-1' });
    expect(mockCreateAuroraTenantApiKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      orgId: 'org-1',
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(3);

    // First update: set auroraTenantId + AURORA_TENANT_CREATED
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'SET auroraTenantId = :tid, setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(setupStatus) OR setupStatus = :expected',
      ExpressionAttributeValues: {
        ':tid': { S: 'aurora-t-1' },
        ':status': { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        ':expected': { S: OrgSetupStatus.FILONE_ORG_CREATED },
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

    // Third update: set AURORA_TENANT_API_KEY_CREATED
    expect(updateCalls[2].args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'SET setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'setupStatus = :expected',
      ExpressionAttributeValues: {
        ':status': { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        ':expected': { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        ':now': { S: expect.any(String) },
      },
    });

    // SSM: stores API key
    const ssmCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(ssmCalls).toHaveLength(1);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-portal/tenant-api-key/aurora-t-1',
      Value: 'atp_secret',
      Type: 'SecureString',
      Overwrite: true,
    });
  });

  it('runs setup and creates API key when status is AURORA_TENANT_CREATED', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        auroraTenantId: { S: 'aurora-t-2' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-2', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_key', tokenId: 'tok-2' });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-2' });
    expect(mockCreateAuroraTenantApiKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-2',
      orgId: 'org-1',
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE,
    });
    expect(updateCalls[1].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
    });
  });

  it('creates only API key when status is AURORA_TENANT_SETUP_COMPLETE', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        auroraTenantId: { S: 'aurora-t-3' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_key3', tokenId: 'tok-3' });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).not.toHaveBeenCalled();
    expect(mockCreateAuroraTenantApiKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-3',
      orgId: 'org-1',
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
    });

    const ssmCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(ssmCalls).toHaveLength(1);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-portal/tenant-api-key/aurora-t-3',
      Value: 'atp_key3',
      Type: 'SecureString',
      Overwrite: true,
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

    await expect(processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' })).rejects.toThrow(
      'Aurora tenant setup not finished for org org-1: lastSetupStep=WARM_TIER_ADDED',
    );
  });

  it('creates tenant, runs setup, and creates API key when setupStatus is undefined', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileItem({}));
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-new' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-new', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_new', tokenId: 'tok-new' });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).toHaveBeenCalledWith({
      orgId: 'org-1',
      displayName: 'Test Org',
    });
    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-new' });
    expect(mockCreateAuroraTenantApiKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-new',
      orgId: 'org-1',
    });
  });

  it('throws when org profile is not found', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(
      processTenantSetup({ orgId: 'org-missing', orgName: 'Missing Org' }),
    ).rejects.toThrow('Org profile not found for org org-missing');
  });
});
