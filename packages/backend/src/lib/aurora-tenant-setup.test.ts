import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

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

const mockCreateAuroraAccessKey = vi.fn();

vi.mock('./aurora-portal.js', () => ({
  createAuroraAccessKey: (...args: unknown[]) => mockCreateAuroraAccessKey(...args),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);

import { ACCESS_KEY_PERMISSIONS } from '@filone/shared';
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

function setupDefaultS3AccessKeyMock() {
  mockCreateAuroraAccessKey.mockResolvedValue({
    id: 'ak-1',
    accessKeyId: 'AKIA_CONSOLE',
    accessKeySecret: 's3_secret',
    createdAt: '2024-01-01T00:00:00Z',
  });
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

  it('is a no-op when setupStatus is AURORA_S3_ACCESS_KEY_CREATED', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(
        orgProfileItem({ setupStatus: { S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED } }),
      );

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).not.toHaveBeenCalled();
    expect(mockCreateAuroraTenantApiKey).not.toHaveBeenCalled();
    expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('creates only S3 access key when status is AURORA_TENANT_API_KEY_CREATED', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    setupDefaultS3AccessKeyMock();

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).not.toHaveBeenCalled();
    expect(mockCreateAuroraTenantApiKey).not.toHaveBeenCalled();
    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      keyName: 'filone-console',
      permissions: [...ACCESS_KEY_PERMISSIONS],
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
    });

    const ssmCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(ssmCalls).toHaveLength(1);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-s3/access-key/aurora-t-1',
      Value: JSON.stringify({ accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' }),
      Type: 'SecureString',
      Overwrite: true,
    });
  });

  it('creates full pipeline when status is FILONE_ORG_CREATED', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(orgProfileItem({ setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED } }));
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-1' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-1', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_secret', tokenId: 'tok-1' });
    setupDefaultS3AccessKeyMock();

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
    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      keyName: 'filone-console',
      permissions: [...ACCESS_KEY_PERMISSIONS],
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(4);

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

    // Fourth update: set AURORA_S3_ACCESS_KEY_CREATED
    expect(updateCalls[3].args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'SET setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'setupStatus = :expected',
      ExpressionAttributeValues: {
        ':status': { S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED },
        ':expected': { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        ':now': { S: expect.any(String) },
      },
    });

    // SSM: stores both API key and S3 access key
    const ssmCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(ssmCalls).toHaveLength(2);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-portal/tenant-api-key/aurora-t-1',
      Value: 'atp_secret',
      Type: 'SecureString',
      Overwrite: true,
    });
    expect(ssmCalls[1].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-s3/access-key/aurora-t-1',
      Value: JSON.stringify({ accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' }),
      Type: 'SecureString',
      Overwrite: true,
    });
  });

  it('runs setup, creates API key, and S3 key when status is AURORA_TENANT_CREATED', async () => {
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
    setupDefaultS3AccessKeyMock();

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-2' });
    expect(mockCreateAuroraTenantApiKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-2',
      orgId: 'org-1',
    });
    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-2',
      keyName: 'filone-console',
      permissions: [...ACCESS_KEY_PERMISSIONS],
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(3);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE,
    });
    expect(updateCalls[1].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
    });
    expect(updateCalls[2].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
    });
  });

  it('creates API key and S3 key when status is AURORA_TENANT_SETUP_COMPLETE', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        auroraTenantId: { S: 'aurora-t-3' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_key3', tokenId: 'tok-3' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    expect(mockCreateAuroraTenant).not.toHaveBeenCalled();
    expect(mockSetupAuroraTenant).not.toHaveBeenCalled();
    expect(mockCreateAuroraTenantApiKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-3',
      orgId: 'org-1',
    });
    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-3',
      keyName: 'filone-console',
      permissions: [...ACCESS_KEY_PERMISSIONS],
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
    });
    expect(updateCalls[1].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
    });

    const ssmCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(ssmCalls).toHaveLength(2);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-portal/tenant-api-key/aurora-t-3',
      Value: 'atp_key3',
      Type: 'SecureString',
      Overwrite: true,
    });
    expect(ssmCalls[1].args[0].input).toStrictEqual({
      Name: '/filone/test/aurora-s3/access-key/aurora-t-3',
      Value: JSON.stringify({ accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' }),
      Type: 'SecureString',
      Overwrite: true,
    });
  });

  it('advances status on DuplicateKeyNameError when SSM has credentials', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-4' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    const duplicateError = new Error('An access key with this name already exists');
    duplicateError.name = 'DuplicateKeyNameError';
    mockCreateAuroraAccessKey.mockRejectedValue(duplicateError);
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: '{}' } });

    await processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
    });
  });

  it('re-throws DuplicateKeyNameError when SSM does not have credentials', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-4' },
      }),
    );
    const duplicateError = new Error('An access key with this name already exists');
    duplicateError.name = 'DuplicateKeyNameError';
    mockCreateAuroraAccessKey.mockRejectedValue(duplicateError);
    const paramNotFound = new Error('Parameter not found');
    paramNotFound.name = 'ParameterNotFound';
    ssmMock.on(GetParameterCommand).rejects(paramNotFound);

    await expect(processTenantSetup({ orgId: 'org-1', orgName: 'Test Org' })).rejects.toThrow(
      'An access key with this name already exists',
    );

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
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

  it('creates full pipeline when setupStatus is undefined', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileItem({}));
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-new' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-new', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_new', tokenId: 'tok-new' });
    setupDefaultS3AccessKeyMock();

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
    expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
      tenantId: 'aurora-t-new',
      keyName: 'filone-console',
      permissions: [...ACCESS_KEY_PERMISSIONS],
    });
  });

  it('throws when org profile is not found', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(
      processTenantSetup({ orgId: 'org-missing', orgName: 'Missing Org' }),
    ).rejects.toThrow('Org profile not found for org org-missing');
  });
});
