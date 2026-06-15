import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

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

const mockUpdateAuroraTenantStatusApi = vi.fn();
const mockGetAuroraTenantStatusApi = vi.fn();
const mockGetStorageSamples = vi.fn();
const mockGetOperationsSamples = vi.fn();
vi.mock('./aurora-backoffice.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../aurora/aurora-backoffice.js')>();
  return {
    ...original,
    updateTenantStatus: (...args: unknown[]) => mockUpdateAuroraTenantStatusApi(...args),
    getTenantStatus: (...args: unknown[]) => mockGetAuroraTenantStatusApi(...args),
    getStorageSamples: (...args: unknown[]) => mockGetStorageSamples(...args),
    getOperationsSamples: (...args: unknown[]) => mockGetOperationsSamples(...args),
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
import type { OrgProfileItem } from '../org-profile.js';
import { FINAL_SETUP_STATUS, OrgSetupStatus } from '../org-setup-status.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
  NotImplementedError,
} from '../errors.js';

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
    it('returns the tenantId when the Aurora tenant setup is complete', () => {
      const result = auroraOrchestrator.isTenantReady({
        auroraTenantId: { S: 'aurora-t-1' },
        auroraSetupStatus: { S: FINAL_SETUP_STATUS },
      });

      expect(result).toEqual('aurora-t-1');
    });

    const notReadyCases: Record<string, OrgProfileItem | undefined> = {
      'the Aurora setup status was not completed yet': {
        auroraTenantId: { S: 'aurora-t-1' },
        auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_API_KEY_CREATED },
      },
      'the PROFILE row is missing the tenantId': {
        auroraSetupStatus: { S: FINAL_SETUP_STATUS },
      },
      'no PROFILE row exists': undefined,
    };

    for (const [desc, orgProfile] of Object.entries(notReadyCases)) {
      it(`returns null when ${desc}`, () => {
        expect(auroraOrchestrator.isTenantReady(orgProfile)).toBeNull();
      });
    }
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
          bucketName: 'a',
          region: S3Region.EuWest1,
          createdAt: '2026-01-01T00:00:00Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
        {
          bucketName: 'b',
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
      expect(result[0]?.bucketName).toBe('a');
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
        bucketName: 'b',
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

  describe('updateTenantStatus', () => {
    const statusCases: Record<string, 'ACTIVE' | 'WRITE_LOCKED' | 'DISABLED'> = {
      active: 'ACTIVE',
      'write-locked': 'WRITE_LOCKED',
      disabled: 'DISABLED',
    };

    for (const [status, modelsStatus] of Object.entries(statusCases)) {
      it(`maps "${status}" to ${modelsStatus} and calls the aurora-backoffice helper`, async () => {
        mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);

        await auroraOrchestrator.updateTenantStatus('aurora-t-1', status as never);

        expect(mockUpdateAuroraTenantStatusApi).toHaveBeenCalledWith({
          tenantId: 'aurora-t-1',
          status: modelsStatus,
        });
      });
    }
  });

  describe('getTenantStatus', () => {
    const okCases: Record<string, string | undefined> = {
      ACTIVE: 'active',
      WRITE_LOCKED: 'write-locked',
      DISABLED: 'disabled',
      LOCKED: undefined,
    };

    for (const [modelsStatus, expected] of Object.entries(okCases)) {
      it(`maps ${modelsStatus} to ${expected ?? 'undefined'}`, async () => {
        mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: modelsStatus });

        const result = await auroraOrchestrator.getTenantStatus('aurora-t-1');

        expect(result).toEqual({ kind: 'ok', status: expected });
      });
    }

    it('maps an ok result with no status to undefined', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: undefined });

      const result = await auroraOrchestrator.getTenantStatus('aurora-t-1');

      expect(result).toEqual({ kind: 'ok', status: undefined });
    });

    it('passes a not_found result through unchanged', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'not_found' });

      const result = await auroraOrchestrator.getTenantStatus('aurora-t-1');

      expect(result).toEqual({ kind: 'not_found' });
    });

    it('passes an error result through unchanged', async () => {
      const cause = new Error('boom');
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'error', cause });

      const result = await auroraOrchestrator.getTenantStatus('aurora-t-1');

      expect(result).toEqual({ kind: 'error', cause });
    });
  });

  describe('getS3ClientContext', () => {
    it('returns endpoint + credentials with Aurora-specific knobs', async () => {
      mockSsmCredentials('aurora-t-1', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });

      const ctx = await auroraOrchestrator.getS3ClientContext('aurora-t-1');

      expect(ctx).toEqual({
        endpointUrl: expect.stringContaining('aur.lu'),
        region: 'auto',
        credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
        forcePathStyle: true,
      });
    });
  });

  describe('getTenantUsageMetrics', () => {
    const FROM = '2026-01-01T00:00:00Z';
    const TO = '2026-01-31T00:00:00Z';

    beforeEach(() => {
      mockGetStorageSamples.mockResolvedValue([]);
      mockGetOperationsSamples.mockResolvedValue([]);
    });

    it('forwards tenantId, from, to and defaults window to "24h" when interval is omitted', async () => {
      await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', { from: FROM, to: TO });

      expect(mockGetStorageSamples).toHaveBeenCalledWith({
        tenantId: 'aurora-t-1',
        from: FROM,
        to: TO,
        window: '24h',
      });
      expect(mockGetOperationsSamples).toHaveBeenCalledWith({
        tenantId: 'aurora-t-1',
        from: FROM,
        to: TO,
        window: '24h',
      });
    });

    it('forwards a custom interval as the window to both helpers', async () => {
      await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', {
        from: FROM,
        to: TO,
        interval: '24h',
      });

      expect(mockGetStorageSamples).toHaveBeenCalledWith(
        expect.objectContaining({ window: '24h' }),
      );
      expect(mockGetOperationsSamples).toHaveBeenCalledWith(
        expect.objectContaining({ window: '24h' }),
      );
    });

    // Aurora's API only accepts m/h units, so the orchestrator-agnostic '1d'
    // interval must be translated before it hits the wire.
    it('translates interval "1d" to window "24h" for Aurora', async () => {
      await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', {
        from: FROM,
        to: TO,
        interval: '1d',
      });

      expect(mockGetStorageSamples).toHaveBeenCalledWith(
        expect.objectContaining({ window: '24h' }),
      );
      expect(mockGetOperationsSamples).toHaveBeenCalledWith(
        expect.objectContaining({ window: '24h' }),
      );
    });

    it('maps storage samples to the normalized shape, applying ?? 0 defaults', async () => {
      mockGetStorageSamples.mockResolvedValue([
        { timestamp: '2026-01-01T01:00:00Z', bytesUsed: 1024, objectCount: 5 },
        { timestamp: '2026-01-01T02:00:00Z' }, // bytesUsed and objectCount missing
      ]);

      const result = await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', {
        from: FROM,
        to: TO,
      });

      expect(result.storage).toEqual([
        { timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 1024, objectCount: 5 },
        { timestamp: '2026-01-01T02:00:00.000Z', bytesUsed: 0, objectCount: 0 },
      ]);
    });

    it('maps operations samples to egress shape, using txBytes with ?? 0 default', async () => {
      mockGetOperationsSamples.mockResolvedValue([
        { timestamp: '2026-01-01T01:00:00Z', txBytes: 512 },
        { timestamp: '2026-01-01T02:00:00Z' }, // txBytes missing
      ]);

      const result = await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', {
        from: FROM,
        to: TO,
      });

      expect(result.egress).toEqual([
        { timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 512 },
        { timestamp: '2026-01-01T02:00:00.000Z', bytesUsed: 0 },
      ]);
    });

    it('drops storage samples that are missing a timestamp', async () => {
      mockGetStorageSamples.mockResolvedValue([
        { timestamp: '2026-01-01T01:00:00Z', bytesUsed: 100, objectCount: 1 },
        { bytesUsed: 200, objectCount: 2 }, // no timestamp — should be dropped
      ]);

      const result = await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', {
        from: FROM,
        to: TO,
      });

      expect(result.storage).toHaveLength(1);
      expect(result.storage[0]?.timestamp).toBe('2026-01-01T01:00:00.000Z');
    });

    it('drops egress samples that are missing a timestamp', async () => {
      mockGetOperationsSamples.mockResolvedValue([
        { timestamp: '2026-01-01T01:00:00Z', txBytes: 256 },
        { txBytes: 512 }, // no timestamp — should be dropped
      ]);

      const result = await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', {
        from: FROM,
        to: TO,
      });

      expect(result.egress).toHaveLength(1);
      expect(result.egress[0]?.timestamp).toBe('2026-01-01T01:00:00.000Z');
    });

    it('returns empty arrays when both helpers return no samples', async () => {
      const result = await auroraOrchestrator.getTenantUsageMetrics('aurora-t-1', {
        from: FROM,
        to: TO,
      });

      expect(result).toEqual({ storage: [], egress: [] });
    });
  });
});
