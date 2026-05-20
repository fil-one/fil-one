import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);

const mockEnsureAuroraTenantReady = vi.fn();
vi.mock('./aurora-tenant-setup.js', () => ({
  ensureTenantReady: (...args: unknown[]) => mockEnsureAuroraTenantReady(...args),
}));

const mockCreateAuroraBucket = vi.fn();
const mockCreateAuroraAccessKey = vi.fn();
const mockFindAuroraAccessKeyByName = vi.fn();
const mockGetAuroraPortalApiKey = vi.fn();

vi.mock('./aurora-portal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../aurora/aurora-portal.js')>();
  return {
    ...original,
    createAuroraBucket: (...args: unknown[]) => mockCreateAuroraBucket(...args),
    createAuroraAccessKey: (...args: unknown[]) => mockCreateAuroraAccessKey(...args),
    findAuroraAccessKeyByName: (...args: unknown[]) => mockFindAuroraAccessKeyByName(...args),
    getAuroraPortalApiKey: (...args: unknown[]) => mockGetAuroraPortalApiKey(...args),
  };
});

const mockPortalListBuckets = vi.fn();
const mockPortalGetBucketInfo = vi.fn();
vi.mock('@filone/aurora-portal-client', () => ({
  createClient: () => 'mock-portal-client',
  listBuckets: (...args: unknown[]) => mockPortalListBuckets(...args),
  getBucketInfo: (...args: unknown[]) => mockPortalGetBucketInfo(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_PORTAL_URL = 'https://portal.dev.aur.lu/api';

import { S3Region } from '@filone/shared';
import { auroraOrchestrator, _resetSsmCacheForTesting } from './aurora-orchestrator.js';
import { FINAL_SETUP_STATUS, OrgSetupStatus } from '../org-setup-status.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
  NotImplementedError,
} from '../service-orchestrator.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function mockSsmCredentials(
  tenantId: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
) {
  ssmMock
    .on(GetParameterCommand, {
      Name: `/filone/test/aurora-s3/access-key/${tenantId}`,
      WithDecryption: true,
    })
    .resolves({ Parameter: { Value: JSON.stringify(credentials) } });
}

describe('auroraOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmMock.reset();
    _resetSsmCacheForTesting();
  });

  it('exposes the Aurora provider id and region', () => {
    expect(auroraOrchestrator.id).toBe('aurora');
    expect(auroraOrchestrator.region).toBe('eu-west-1');
  });

  describe('ensureTenantReady', () => {
    it('translates the legacy {ok, auroraTenantId} shape to {ok, tenantId}', async () => {
      mockEnsureAuroraTenantReady.mockResolvedValue({ ok: true, auroraTenantId: 'aurora-t-1' });

      const result = await auroraOrchestrator.ensureTenantReady('org-1');

      expect(result).toEqual('aurora-t-1');
      expect(mockEnsureAuroraTenantReady).toHaveBeenCalledWith('org-1');
    });

    it('returns null when the Aurora tenant setup fails', async () => {
      mockEnsureAuroraTenantReady.mockResolvedValue({
        ok: false,
        errorResponse: { statusCode: 503, body: JSON.stringify({ message: 'busy' }) },
      });

      const result = await auroraOrchestrator.ensureTenantReady('org-1');

      expect(result).toBeNull();
    });
  });

  describe('isTenantReady', () => {
    beforeEach(() => {
      ddbMock.reset();
    });

    it('returns the tenantId when the Aurora tenant setup is complete', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          auroraTenantId: { S: 'aurora-t-1' },
          setupStatus: { S: FINAL_SETUP_STATUS },
        },
      });

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toEqual('aurora-t-1');
      expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toMatchObject({
        TableName: 'UserInfoTable',
        Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      });
    });

    it('returns null when the Aurora setup status was not completed yet ', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          auroraTenantId: { S: 'aurora-t-1' },
          setupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
        },
      });

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toBeNull();
    });

    it('returns null when the PROFILE row is missing the tenantId', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: { setupStatus: { S: FINAL_SETUP_STATUS } },
      });

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toBeNull();
    });

    it('returns null when no PROFILE row exists', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: undefined });

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toBeNull();
    });
  });

  describe('createBucket', () => {
    it('forwards all bucket fields to createAuroraBucket', async () => {
      mockCreateAuroraBucket.mockResolvedValue(undefined);

      await auroraOrchestrator.createBucket('aurora-t-1', {
        bucketName: 'my-bucket',
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'compliance', duration: 30, durationType: 'd' },
      });

      expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
        tenantId: 'aurora-t-1',
        bucketName: 'my-bucket',
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'compliance', duration: 30, durationType: 'd' },
      });
    });

    it('propagates BucketAlreadyExistsError from the Aurora portal', async () => {
      mockCreateAuroraBucket.mockRejectedValue(new BucketAlreadyExistsError('dup'));

      await expect(
        auroraOrchestrator.createBucket('aurora-t-1', { bucketName: 'dup' }),
      ).rejects.toBeInstanceOf(BucketAlreadyExistsError);
    });

    it('re-throws other Aurora Portal errors unchanged', async () => {
      mockCreateAuroraBucket.mockRejectedValue(new Error('upstream 500'));

      await expect(
        auroraOrchestrator.createBucket('aurora-t-1', { bucketName: 'b' }),
      ).rejects.toThrow('upstream 500');
    });
  });

  describe('deleteBucket', () => {
    it('throws NotImplementedError — Aurora delete is tracked in FIL-204', async () => {
      await expect(
        auroraOrchestrator.deleteBucket('aurora-t-1', 'my-bucket'),
      ).rejects.toBeInstanceOf(NotImplementedError);
    });
  });

  describe('listBuckets', () => {
    it('maps Aurora Portal response items to BucketSummary objects', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalListBuckets.mockResolvedValue({
        data: {
          items: [
            { name: 'a', createdAt: '2026-01-01T00:00:00Z' },
            {
              name: 'b',
              createdAt: '2026-01-02T00:00:00Z',
              flags: ['versioned', 'encrypted'],
            },
          ],
        },
        error: undefined,
      });

      const result = await auroraOrchestrator.listBuckets('aurora-t-1');

      expect(result).toEqual([
        {
          name: 'a',
          region: S3Region.EuWest1,
          createdAt: '2026-01-01T00:00:00Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
        {
          name: 'b',
          region: S3Region.EuWest1,
          createdAt: '2026-01-02T00:00:00Z',
          isPublic: false,
          versioning: true,
          encrypted: true,
        },
      ]);
    });

    it('drops items missing name or createdAt', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalListBuckets.mockResolvedValue({
        data: {
          items: [
            { name: 'a', createdAt: '2026-01-01T00:00:00Z' },
            { name: undefined, createdAt: '2026-01-02T00:00:00Z' },
            { name: 'c', createdAt: undefined },
          ],
        },
        error: undefined,
      });

      const result = await auroraOrchestrator.listBuckets('aurora-t-1');

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('a');
    });

    it('throws when the Aurora Portal returns an error', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalListBuckets.mockResolvedValue({
        data: undefined,
        error: { message: 'boom' },
      });

      await expect(auroraOrchestrator.listBuckets('aurora-t-1')).rejects.toThrow(
        /Failed to list buckets from Aurora for tenant aurora-t-1/,
      );
    });
  });

  describe('getBucket', () => {
    it('returns mapped bucket details', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalGetBucketInfo.mockResolvedValue({
        data: {
          name: 'b',
          createdAt: '2026-01-01T00:00:00Z',
          objectLock: true,
          versioning: true,
          encrypted: true,
          defaultRetention: 'compliance',
          retentionDuration: 365,
          retentionDurationType: 'd',
        },
        error: undefined,
        response: { status: 200 },
      });

      const result = await auroraOrchestrator.getBucket('aurora-t-1', 'b');

      expect(result).toEqual({
        name: 'b',
        region: S3Region.EuWest1,
        createdAt: '2026-01-01T00:00:00Z',
        isPublic: false,
        objectLockEnabled: true,
        versioning: true,
        encrypted: true,
        defaultRetention: 'compliance',
        retentionDuration: 365,
        retentionDurationType: 'd',
      });
    });

    it('maps defaultRetention "off" to undefined', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalGetBucketInfo.mockResolvedValue({
        data: { name: 'b', createdAt: '2026-01-01T00:00:00Z', defaultRetention: 'off' },
        error: undefined,
        response: { status: 200 },
      });

      const result = await auroraOrchestrator.getBucket('aurora-t-1', 'b');

      expect(result?.defaultRetention).toBeUndefined();
    });

    it('returns null when the Aurora Portal responds with 404', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalGetBucketInfo.mockResolvedValue({
        data: undefined,
        error: { message: 'not found' },
        response: { status: 404 },
      });

      const result = await auroraOrchestrator.getBucket('aurora-t-1', 'missing');

      expect(result).toBeNull();
    });

    it('throws on any non-404 Aurora Portal error', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalGetBucketInfo.mockResolvedValue({
        data: undefined,
        error: { message: 'boom' },
        response: { status: 500 },
      });

      await expect(auroraOrchestrator.getBucket('aurora-t-1', 'b')).rejects.toThrow(
        /Failed to get bucket "b" from Aurora for tenant aurora-t-1/,
      );
    });

    it('throws when Aurora returns success but no createdAt', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalGetBucketInfo.mockResolvedValue({
        data: { name: 'b' },
        error: undefined,
        response: { status: 200 },
      });

      await expect(auroraOrchestrator.getBucket('aurora-t-1', 'b')).rejects.toThrow(
        /Aurora returned incomplete data/,
      );
    });
  });

  describe('issueAccessKey', () => {
    it('forwards key params and translates the issued key', async () => {
      mockCreateAuroraAccessKey.mockResolvedValue({
        id: 'k1',
        accessKeyId: 'AK1',
        accessKeySecret: 'secret',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const result = await auroraOrchestrator.issueAccessKey('aurora-t-1', {
        keyName: 'console',
        permissions: ['read', 'write'],
        granularPermissions: ['ListBucketVersions'] as never,
        buckets: ['b1'],
        expiresAt: '2026-12-31',
      });

      expect(result).toEqual({
        id: 'k1',
        accessKeyId: 'AK1',
        accessKeySecret: 'secret',
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(mockCreateAuroraAccessKey).toHaveBeenCalledWith({
        tenantId: 'aurora-t-1',
        keyName: 'console',
        permissions: ['read', 'write'],
        granularPermissions: ['ListBucketVersions'],
        buckets: ['b1'],
        expiresAt: '2026-12-31',
      });
    });

    it('propagates AccessKeyAlreadyExistsError from the Aurora portal', async () => {
      mockCreateAuroraAccessKey.mockRejectedValue(new AccessKeyAlreadyExistsError());

      await expect(
        auroraOrchestrator.issueAccessKey('aurora-t-1', {
          keyName: 'k',
          permissions: ['read'],
        }),
      ).rejects.toBeInstanceOf(AccessKeyAlreadyExistsError);
    });

    it('propagates AccessKeyValidationError from the Aurora portal and preserves the message', async () => {
      mockCreateAuroraAccessKey.mockRejectedValue(new AccessKeyValidationError('bad name'));

      const promise = auroraOrchestrator.issueAccessKey('aurora-t-1', {
        keyName: 'k',
        permissions: ['read'],
      });
      await expect(promise).rejects.toBeInstanceOf(AccessKeyValidationError);
      await expect(promise).rejects.toThrow('bad name');
    });

    it('re-throws unexpected errors unchanged', async () => {
      mockCreateAuroraAccessKey.mockRejectedValue(new Error('upstream 500'));

      await expect(
        auroraOrchestrator.issueAccessKey('aurora-t-1', {
          keyName: 'k',
          permissions: ['read'],
        }),
      ).rejects.toThrow('upstream 500');
    });
  });

  describe('findAccessKeyByName', () => {
    it('delegates to findAuroraAccessKeyByName', async () => {
      mockFindAuroraAccessKeyByName.mockResolvedValue({
        id: 'k1',
        accessKeyId: 'AK1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const result = await auroraOrchestrator.findAccessKeyByName('aurora-t-1', 'console');

      expect(result).toEqual({
        id: 'k1',
        accessKeyId: 'AK1',
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(mockFindAuroraAccessKeyByName).toHaveBeenCalledWith({
        tenantId: 'aurora-t-1',
        keyName: 'console',
      });
    });

    it('returns undefined when no matching key exists', async () => {
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);

      const result = await auroraOrchestrator.findAccessKeyByName('aurora-t-1', 'missing');

      expect(result).toBeUndefined();
    });
  });

  describe('getPresignerContext', () => {
    it('returns endpoint + credentials with Aurora-specific knobs', async () => {
      mockSsmCredentials('aurora-t-1', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });

      const ctx = await auroraOrchestrator.getPresignerContext('aurora-t-1');

      expect(ctx).toEqual({
        endpointUrl: expect.stringContaining('aur.lu'),
        region: 'auto',
        credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
        forcePathStyle: true,
      });
    });
  });
});
