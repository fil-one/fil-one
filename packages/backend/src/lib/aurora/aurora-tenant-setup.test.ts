import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
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

const { FakeDuplicateTokenNameError } = vi.hoisted(() => {
  class FakeDuplicateTokenNameError extends Error {
    constructor() {
      super('An Aurora tenant API token with this name already exists');
      this.name = 'DuplicateTokenNameError';
    }
  }
  return { FakeDuplicateTokenNameError };
});

vi.mock('./aurora-backoffice.js', () => ({
  createAuroraTenant: (...args: unknown[]) => mockCreateAuroraTenant(...args),
  setupAuroraTenant: (...args: unknown[]) => mockSetupAuroraTenant(...args),
  createAuroraTenantApiKey: (...args: unknown[]) => mockCreateAuroraTenantApiKey(...args),
  DuplicateTokenNameError: FakeDuplicateTokenNameError,
}));

const mockCreateAuroraAccessKey = vi.fn();

vi.mock('./aurora-portal.js', () => ({
  createAuroraAccessKey: (...args: unknown[]) => mockCreateAuroraAccessKey(...args),
}));

const mockReportMetric = vi.fn();
vi.mock('../metrics.js', () => ({
  reportMetric: (...args: unknown[]) => mockReportMetric(...args),
}));

const mockScanAndEmitStuckTenantCount = vi.fn().mockResolvedValue(undefined);
vi.mock('../stuck-tenant-metric.js', () => ({
  scanAndEmitStuckTenantCount: (...args: unknown[]) => mockScanAndEmitStuckTenantCount(...args),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);

import { ACCESS_KEY_PERMISSIONS } from '@filone/shared';
import {
  ensureTenantReady,
  processTenantSetup,
  recordSetupFailure,
  OrgSetupStatus,
} from './aurora-tenant-setup.js';

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
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );

    await processTenantSetup('org-1');

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

    await processTenantSetup('org-1');

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
    expect(updateCalls[0].args[0].input.ReturnValues).toBe('ALL_OLD');

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
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
        name: { S: 'Test Org' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-1' });
    mockSetupAuroraTenant.mockResolvedValue({ lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_secret', tokenId: 'tok-1' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

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
      UpdateExpression:
        'SET auroraTenantId = :auroraTenantId, setupStatus = :status, updatedAt = :now',
      ConditionExpression: 'setupStatus = :expected',
      ExpressionAttributeValues: {
        ':auroraTenantId': { S: 'aurora-t-1' },
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

    // Fourth update: set AURORA_S3_ACCESS_KEY_CREATED, with ALL_OLD so the
    // post-write check can read the prior setupFailureCount.
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
      ReturnValues: 'ALL_OLD',
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
    mockSetupAuroraTenant.mockResolvedValue({ lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_key', tokenId: 'tok-2' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

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

    await processTenantSetup('org-1');

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

  it('advances status on DuplicateTokenNameError when SSM has the api token', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        auroraTenantId: { S: 'aurora-t-5' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'atp_existing' } });
    mockCreateAuroraTenantApiKey.mockRejectedValue(new FakeDuplicateTokenNameError());
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    // PutParameter only fires once — for the S3 key, not the api token
    const putParameterCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(putParameterCalls).toHaveLength(1);
    expect(putParameterCalls[0].args[0].input.Name).toBe(
      '/filone/test/aurora-s3/access-key/aurora-t-5',
    );

    // GetParameter fires once — for the api token recovery check
    const getParameterCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(getParameterCalls).toHaveLength(1);
    expect(getParameterCalls[0].args[0].input.Name).toBe(
      '/filone/test/aurora-portal/tenant-api-key/aurora-t-5',
    );

    // Status advances through API_KEY_CREATED → S3_ACCESS_KEY_CREATED.
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
    });
    expect(updateCalls[1].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
    });
  });

  it('re-throws DuplicateTokenNameError when SSM does not have the api token after polling', async () => {
    vi.useFakeTimers();
    try {
      ddbMock.on(GetItemCommand).resolves(
        orgProfileItem({
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          auroraTenantId: { S: 'aurora-t-5' },
        }),
      );
      mockCreateAuroraTenantApiKey.mockRejectedValue(new FakeDuplicateTokenNameError());
      const paramNotFound = new Error('Parameter not found');
      paramNotFound.name = 'ParameterNotFound';
      ssmMock.on(GetParameterCommand).rejects(paramNotFound);

      const promise = processTenantSetup('org-1');
      promise.catch(() => {}); // suppress unhandled-rejection while timers advance
      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow(
        'An Aurora tenant API token with this name already exists',
      );

      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(6);
      expect(mockCreateAuroraAccessKey).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances after polling when api token appears in SSM on a later attempt', async () => {
    vi.useFakeTimers();
    try {
      ddbMock.on(GetItemCommand).resolves(
        orgProfileItem({
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
          auroraTenantId: { S: 'aurora-t-5' },
        }),
      );
      ddbMock.on(UpdateItemCommand).resolves({});
      ssmMock.on(PutParameterCommand).resolves({});
      mockCreateAuroraTenantApiKey.mockRejectedValue(new FakeDuplicateTokenNameError());
      const paramNotFound = new Error('Parameter not found');
      paramNotFound.name = 'ParameterNotFound';
      ssmMock
        .on(GetParameterCommand)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .resolves({ Parameter: { Value: 'atp_existing' } });
      setupDefaultS3AccessKeyMock();

      const promise = processTenantSetup('org-1');
      await vi.runAllTimersAsync();
      await promise;

      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(6);
      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
        S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances status on AccessKeyAlreadyExistsError when SSM has credentials', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-4' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    const duplicateError = new Error('An access key with this name already exists');
    duplicateError.name = 'AccessKeyAlreadyExistsError';
    mockCreateAuroraAccessKey.mockRejectedValue(duplicateError);
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: '{}' } });

    await processTenantSetup('org-1');

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
      S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
    });
  });

  it('re-throws AccessKeyAlreadyExistsError when SSM does not have credentials after polling', async () => {
    vi.useFakeTimers();
    try {
      ddbMock.on(GetItemCommand).resolves(
        orgProfileItem({
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
          auroraTenantId: { S: 'aurora-t-4' },
        }),
      );
      const duplicateError = new Error('An access key with this name already exists');
      duplicateError.name = 'AccessKeyAlreadyExistsError';
      mockCreateAuroraAccessKey.mockRejectedValue(duplicateError);
      const paramNotFound = new Error('Parameter not found');
      paramNotFound.name = 'ParameterNotFound';
      ssmMock.on(GetParameterCommand).rejects(paramNotFound);

      const promise = processTenantSetup('org-1');
      promise.catch(() => {}); // suppress unhandled-rejection while timers advance
      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow('An access key with this name already exists');

      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(6);
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances after polling when S3 access key credentials appear in SSM on a later attempt', async () => {
    vi.useFakeTimers();
    try {
      ddbMock.on(GetItemCommand).resolves(
        orgProfileItem({
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
          auroraTenantId: { S: 'aurora-t-4' },
        }),
      );
      ddbMock.on(UpdateItemCommand).resolves({});
      const duplicateError = new Error('An access key with this name already exists');
      duplicateError.name = 'AccessKeyAlreadyExistsError';
      mockCreateAuroraAccessKey.mockRejectedValue(duplicateError);
      const paramNotFound = new Error('Parameter not found');
      paramNotFound.name = 'ParameterNotFound';
      ssmMock
        .on(GetParameterCommand)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .rejectsOnce(paramNotFound)
        .resolves({ Parameter: { Value: '{}' } });

      const promise = processTenantSetup('org-1');
      await vi.runAllTimersAsync();
      await promise;

      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(6);
      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toStrictEqual({
        S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls setupAuroraTenant until lastSetupStep is FINISHED', async () => {
    vi.useFakeTimers();
    try {
      ddbMock.on(GetItemCommand).resolves(
        orgProfileItem({
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
          auroraTenantId: { S: 'aurora-t-3' },
        }),
      );
      ddbMock.on(UpdateItemCommand).resolves({});
      ssmMock.on(PutParameterCommand).resolves({});
      mockSetupAuroraTenant
        .mockResolvedValueOnce({ id: 'aurora-t-3', lastSetupStep: 'WARM_TIER_ADDED' })
        .mockResolvedValueOnce({ id: 'aurora-t-3', lastSetupStep: 'WARM_TIER_ADDED' })
        .mockResolvedValueOnce({ id: 'aurora-t-3', lastSetupStep: 'FINISHED' });
      mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp', tokenId: 'tok' });
      setupDefaultS3AccessKeyMock();

      const promise = processTenantSetup('org-1');
      await vi.runAllTimersAsync();
      await promise;

      expect(mockSetupAuroraTenant).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when setupAuroraTenant never reports FINISHED within the poll budget', async () => {
    vi.useFakeTimers();
    try {
      ddbMock.on(GetItemCommand).resolves(
        orgProfileItem({
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
          auroraTenantId: { S: 'aurora-t-3' },
        }),
      );
      mockSetupAuroraTenant.mockResolvedValue({
        id: 'aurora-t-3',
        lastSetupStep: 'WARM_TIER_ADDED',
      });

      const promise = processTenantSetup('org-1');
      promise.catch(() => {});
      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow(
        'Aurora tenant setup not finished for org org-1: lastSetupStep=WARM_TIER_ADDED',
      );

      // 1 initial attempt + 6 retries on the backoff schedule
      expect(mockSetupAuroraTenant).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits AuroraTenantSetupDuration when setup completes via the FILONE_ORG_CREATED branch', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(orgProfileItem({ setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED } }));
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-1' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-1', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp', tokenId: 'tok' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    const durationCalls = mockReportMetric.mock.calls.filter((call) =>
      call[0]?._aws?.CloudWatchMetrics?.[0]?.Metrics?.some(
        (m: { Name: string }) => m.Name === 'AuroraTenantSetupDuration',
      ),
    );
    expect(durationCalls).toHaveLength(1);
    expect(durationCalls[0][0]).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [[]],
            Metrics: [{ Name: 'AuroraTenantSetupDuration', Unit: 'Milliseconds' }],
          },
        ],
      },
      AuroraTenantSetupDuration: expect.any(Number),
    });
    expect(durationCalls[0][0].AuroraTenantSetupDuration).toBeGreaterThanOrEqual(0);
  });

  it('emits AuroraTenantSetupDuration when runSetup exhausts the poll budget on the FILONE_ORG_CREATED branch', async () => {
    vi.useFakeTimers();
    try {
      ddbMock
        .on(GetItemCommand)
        .resolves(orgProfileItem({ setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED } }));
      ddbMock.on(UpdateItemCommand).resolves({});
      mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-1' });
      mockSetupAuroraTenant.mockResolvedValue({
        id: 'aurora-t-1',
        lastSetupStep: 'WARM_TIER_ADDED',
      });

      const promise = processTenantSetup('org-1');
      promise.catch(() => {});
      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow(/Aurora tenant setup not finished/);

      const durationCalls = mockReportMetric.mock.calls.filter((call) =>
        call[0]?._aws?.CloudWatchMetrics?.[0]?.Metrics?.some(
          (m: { Name: string }) => m.Name === 'AuroraTenantSetupDuration',
        ),
      );
      expect(durationCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit AuroraTenantSetupDuration when resuming from the AURORA_TENANT_CREATED branch', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        auroraTenantId: { S: 'aurora-t-2' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockSetupAuroraTenant.mockResolvedValue({ lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp', tokenId: 'tok' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    const durationCalls = mockReportMetric.mock.calls.filter((call) =>
      call[0]?._aws?.CloudWatchMetrics?.[0]?.Metrics?.some(
        (m: { Name: string }) => m.Name === 'AuroraTenantSetupDuration',
      ),
    );
    expect(durationCalls).toHaveLength(0);
  });

  it('creates full pipeline when setupStatus is FILONE_ORG_CREATED', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
        name: { S: 'Test Org' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-new' });
    mockSetupAuroraTenant.mockResolvedValue({ lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_new', tokenId: 'tok-new' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

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

    await expect(processTenantSetup('org-missing')).rejects.toThrow(
      'Org profile not found for org org-missing',
    );
  });

  it('throws when setupStatus attribute is missing on the org profile', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileItem({}));

    await expect(processTenantSetup('org-1')).rejects.toThrow(
      'Unexpected setupStatus "undefined" for org org-1',
    );
  });

  // Helper: build a ConditionalCheckFailedException as Dynamo would throw it.
  function conditionalCheckFailed() {
    return new ConditionalCheckFailedException({
      $metadata: {},
      message: 'The conditional request failed',
    });
  }

  it('continues the chain when createTenant loses the status-advance race', async () => {
    // Initial entry-point GetItem: status is FILONE_ORG_CREATED.
    // Re-read after CCE: winner has written AURORA_TENANT_CREATED + auroraTenantId.
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce(orgProfileItem({ setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED } }))
      .resolves(
        orgProfileItem({
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
          auroraTenantId: { S: 'aurora-t-race' },
        }),
      );
    // First UpdateItem (createTenant) loses the race; subsequent updates succeed.
    ddbMock.on(UpdateItemCommand).rejectsOnce(conditionalCheckFailed()).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-race' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-race', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp_race', tokenId: 'tok-race' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    expect(mockSetupAuroraTenant).toHaveBeenCalledWith({ tenantId: 'aurora-t-race' });
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(2);
  });

  it('continues the chain when runSetup loses the status-advance race', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    // runSetup's UpdateItem (first one for this entry point) loses race; others succeed.
    ddbMock.on(UpdateItemCommand).rejectsOnce(conditionalCheckFailed()).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-1', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp', tokenId: 'tok' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    expect(mockCreateAuroraTenantApiKey).toHaveBeenCalled();
    expect(mockCreateAuroraAccessKey).toHaveBeenCalled();
  });

  it('continues the chain when createAndStoreApiKey loses the status-advance race', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_SETUP_COMPLETE },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    ddbMock.on(UpdateItemCommand).rejectsOnce(conditionalCheckFailed()).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp', tokenId: 'tok' });
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    expect(mockCreateAuroraAccessKey).toHaveBeenCalled();
  });

  it('returns silently when createAndStoreS3AccessKey loses the status-advance race', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    ddbMock.on(UpdateItemCommand).rejects(conditionalCheckFailed());
    ssmMock.on(PutParameterCommand).resolves({});
    setupDefaultS3AccessKeyMock();

    await expect(processTenantSetup('org-1')).resolves.toStrictEqual({
      auroraTenantId: 'aurora-t-1',
    });
  });

  it('reads the org profile with strong consistency', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );

    await processTenantSetup('org-1');

    const getCalls = ddbMock.commandCalls(GetItemCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input.ConsistentRead).toBe(true);
  });
});

describe('stuck-tenant gauge refresh on terminal advance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ssmMock.reset();
  });

  it('re-emits StuckAuroraTenantSetupCount when prior failureCount was >= 3 (alert clears)', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    // The path from AURORA_TENANT_API_KEY_CREATED issues exactly one
    // UpdateItem — the terminal advance. Its ALL_OLD response carries the
    // prior setupFailureCount used by the post-write check.
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: { setupFailureCount: { N: '5' } } });
    ssmMock.on(PutParameterCommand).resolves({});
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    expect(mockScanAndEmitStuckTenantCount).toHaveBeenCalledTimes(1);
  });

  it('does not re-emit StuckAuroraTenantSetupCount when prior failureCount was below 3', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: { setupFailureCount: { N: '2' } } });
    ssmMock.on(PutParameterCommand).resolves({});
    setupDefaultS3AccessKeyMock();

    await processTenantSetup('org-1');

    expect(mockScanAndEmitStuckTenantCount).not.toHaveBeenCalled();
  });

  it('does not re-emit StuckAuroraTenantSetupCount when the terminal advance loses the race', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        $metadata: {},
        message: 'The conditional request failed',
      }),
    );
    ssmMock.on(PutParameterCommand).resolves({});
    setupDefaultS3AccessKeyMock();

    await expect(processTenantSetup('org-1')).resolves.toStrictEqual({
      auroraTenantId: 'aurora-t-1',
    });
    expect(mockScanAndEmitStuckTenantCount).not.toHaveBeenCalled();
  });
});

describe('recordSetupFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('atomically increments setupFailureCount via ADD on the org profile', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: { setupFailureCount: { N: '1' } } });

    await recordSetupFailure('org-1');

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toMatchObject({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'ADD setupFailureCount :one SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(setupStatus)',
      ReturnValues: 'UPDATED_NEW',
    });
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':one': { N: '1' },
      ':now': { S: expect.any(String) },
    });
  });

  it('does not call scanAndEmitStuckTenantCount when newCount is below 3', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: { setupFailureCount: { N: '2' } } });

    await recordSetupFailure('org-1');

    expect(mockScanAndEmitStuckTenantCount).not.toHaveBeenCalled();
  });

  it('calls scanAndEmitStuckTenantCount when newCount transitions to exactly 3', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: { setupFailureCount: { N: '3' } } });

    await recordSetupFailure('org-1');

    expect(mockScanAndEmitStuckTenantCount).toHaveBeenCalledTimes(1);
  });

  it('does not call scanAndEmitStuckTenantCount when newCount is above 3 (already stuck)', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: { setupFailureCount: { N: '4' } } });

    await recordSetupFailure('org-1');

    expect(mockScanAndEmitStuckTenantCount).not.toHaveBeenCalled();
  });
});

describe('ensureTenantReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ssmMock.reset();
  });

  it('returns the auroraTenantId when setup completes successfully', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(orgProfileItem({ setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED } }));
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    mockCreateAuroraTenant.mockResolvedValue({ auroraTenantId: 'aurora-t-1' });
    mockSetupAuroraTenant.mockResolvedValue({ id: 'aurora-t-1', lastSetupStep: 'FINISHED' });
    mockCreateAuroraTenantApiKey.mockResolvedValue({ token: 'atp', tokenId: 'tok' });
    setupDefaultS3AccessKeyMock();

    const result = await ensureTenantReady('org-1');

    expect(result).toStrictEqual({ ok: true, auroraTenantId: 'aurora-t-1' });
  });

  it('records a failure and returns 503 error response when processTenantSetup throws', async () => {
    ddbMock.on(GetItemCommand).resolves(
      orgProfileItem({
        setupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
        auroraTenantId: { S: 'aurora-t-1' },
      }),
    );
    // The recordSetupFailure ADD update needs a specific response. Register
    // the catch-all first, then the specific matcher so it takes precedence.
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock
      .on(UpdateItemCommand, {
        UpdateExpression: 'ADD setupFailureCount :one SET updatedAt = :now',
      })
      .resolves({ Attributes: { setupFailureCount: { N: '1' } } });
    mockSetupAuroraTenant.mockRejectedValue(new Error('Aurora is down'));

    const result = await ensureTenantReady('org-1');

    expect(result.ok).toBe(false);

    const addCalls = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter(
        (c) =>
          c.args[0].input.UpdateExpression === 'ADD setupFailureCount :one SET updatedAt = :now',
      );
    expect(addCalls).toHaveLength(1);
  });
});
