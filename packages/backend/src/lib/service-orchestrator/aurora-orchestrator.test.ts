import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockEnsureAuroraTenantReady = vi.fn();
vi.mock('../aurora-tenant-setup.js', () => ({
  ensureTenantReady: (...args: unknown[]) => mockEnsureAuroraTenantReady(...args),
}));

const mockCreateAuroraBucket = vi.fn();
const mockCreateAuroraAccessKey = vi.fn();
const mockFindAuroraAccessKeyByName = vi.fn();
const mockGetAuroraPortalApiKey = vi.fn();

vi.mock('../aurora-portal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../aurora-portal.js')>();
  return {
    ...original,
    createAuroraBucket: (...args: unknown[]) => mockCreateAuroraBucket(...args),
    createAuroraAccessKey: (...args: unknown[]) => mockCreateAuroraAccessKey(...args),
    findAuroraAccessKeyByName: (...args: unknown[]) => mockFindAuroraAccessKeyByName(...args),
    getAuroraPortalApiKey: (...args: unknown[]) => mockGetAuroraPortalApiKey(...args),
  };
});

const mockS3DeleteBucket = vi.fn();
const mockGetAuroraS3Credentials = vi.fn();
vi.mock('../aurora-s3-client.js', () => ({
  deleteBucket: (...args: unknown[]) => mockS3DeleteBucket(...args),
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
}));

const mockPortalListBuckets = vi.fn();
const mockPortalGetBucketInfo = vi.fn();
vi.mock('@filone/aurora-portal-client', () => ({
  createClient: () => 'mock-portal-client',
  listBuckets: (...args: unknown[]) => mockPortalListBuckets(...args),
  getBucketInfo: (...args: unknown[]) => mockPortalGetBucketInfo(...args),
}));

const mockReadTenantAttrs = vi.fn();
const mockAdvanceTenantStatus = vi.fn();
const mockRecordTenantSetupFailure = vi.fn();
vi.mock('./tenant-helpers.js', () => ({
  readTenantAttrs: (...args: unknown[]) => mockReadTenantAttrs(...args),
  advanceTenantStatus: (...args: unknown[]) => mockAdvanceTenantStatus(...args),
  recordTenantSetupFailure: (...args: unknown[]) => mockRecordTenantSetupFailure(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_PORTAL_URL = 'https://portal.dev.aur.lu/api';

import { auroraOrchestrator } from './aurora-orchestrator.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
} from './service-orchestrator.js';
import {
  AuroraValidationError,
  BucketAlreadyExistsError as PortalBucketAlreadyExistsError,
  DuplicateKeyNameError,
} from '../aurora-portal.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auroraOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it("collapses any aurora-tenant-setup failure into reason 'setup-incomplete'", async () => {
      mockEnsureAuroraTenantReady.mockResolvedValue({
        ok: false,
        errorResponse: { statusCode: 503, body: JSON.stringify({ message: 'busy' }) },
      });

      const result = await auroraOrchestrator.ensureTenantReady('org-1');

      expect(result).toBeNull();
    });
  });

  describe('isTenantReady', () => {
    const AURORA_ATTRS = {
      statusAttr: 'setupStatus',
      tenantIdAttr: 'auroraTenantId',
      failureCountAttr: 'setupFailureCount',
    };

    it('returns the tenantId when the Aurora setup is terminal', async () => {
      mockReadTenantAttrs.mockResolvedValue({
        tenantId: 'aurora-t-1',
        setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
      });

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toEqual('aurora-t-1');
      expect(mockReadTenantAttrs).toHaveBeenCalledWith('org-1', AURORA_ATTRS, { consistent: true });
    });

    it('returns null when the setup status is non-terminal', async () => {
      mockReadTenantAttrs.mockResolvedValue({
        tenantId: 'aurora-t-1',
        setupStatus: 'AURORA_TENANT_API_KEY_CREATED',
      });

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toBeNull();
    });

    it('returns null when the PROFILE row is missing the tenantId', async () => {
      mockReadTenantAttrs.mockResolvedValue({
        setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
      });

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toBeNull();
    });

    it('returns null when no PROFILE row exists', async () => {
      mockReadTenantAttrs.mockResolvedValue(null);

      const result = await auroraOrchestrator.isTenantReady('org-1');

      expect(result).toBeNull();
    });

    it('is side-effect-free: never advances status or records a failure', async () => {
      mockReadTenantAttrs.mockResolvedValue({
        tenantId: 'aurora-t-1',
        setupStatus: 'AURORA_TENANT_CREATED',
      });

      await auroraOrchestrator.isTenantReady('org-1');

      expect(mockAdvanceTenantStatus).not.toHaveBeenCalled();
      expect(mockRecordTenantSetupFailure).not.toHaveBeenCalled();
      expect(mockEnsureAuroraTenantReady).not.toHaveBeenCalled();
    });
  });

  describe('createBucket', () => {
    it('forwards all bucket fields to createAuroraBucket', async () => {
      mockCreateAuroraBucket.mockResolvedValue(undefined);

      await auroraOrchestrator.createBucket({
        tenantId: 'aurora-t-1',
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

    it('maps Aurora Portal BucketAlreadyExistsError to the abstraction-level error', async () => {
      mockCreateAuroraBucket.mockRejectedValue(new PortalBucketAlreadyExistsError('dup'));

      await expect(
        auroraOrchestrator.createBucket({ tenantId: 'aurora-t-1', bucketName: 'dup' }),
      ).rejects.toBeInstanceOf(BucketAlreadyExistsError);
    });

    it('re-throws other Aurora Portal errors unchanged', async () => {
      mockCreateAuroraBucket.mockRejectedValue(new Error('upstream 500'));

      await expect(
        auroraOrchestrator.createBucket({ tenantId: 'aurora-t-1', bucketName: 'b' }),
      ).rejects.toThrow('upstream 500');
    });
  });

  describe('deleteBucket', () => {
    it('builds a presigner context and calls S3 deleteBucket with it', async () => {
      mockGetAuroraS3Credentials.mockResolvedValue({
        accessKeyId: 'AKIA_X',
        secretAccessKey: 'secret_X',
      });
      mockS3DeleteBucket.mockResolvedValue(undefined);

      await auroraOrchestrator.deleteBucket('aurora-t-1', 'my-bucket');

      expect(mockGetAuroraS3Credentials).toHaveBeenCalledWith('test', 'aurora-t-1');
      expect(mockS3DeleteBucket).toHaveBeenCalledWith(
        expect.stringContaining('aur.lu'),
        { accessKeyId: 'AKIA_X', secretAccessKey: 'secret_X' },
        'my-bucket',
      );
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
        { name: 'a', createdAt: '2026-01-01T00:00:00Z', versioning: false, encrypted: true },
        {
          name: 'b',
          createdAt: '2026-01-02T00:00:00Z',
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
        createdAt: '2026-01-01T00:00:00Z',
        objectLockEnabled: true,
        versioning: true,
        encrypted: true,
        defaultRetention: 'compliance',
        retentionDuration: 365,
        retentionDurationType: 'd',
      });
    });

    it('coerces defaultRetention "off" to undefined', async () => {
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

    it('maps Aurora DuplicateKeyNameError to AccessKeyAlreadyExistsError', async () => {
      mockCreateAuroraAccessKey.mockRejectedValue(new DuplicateKeyNameError());

      await expect(
        auroraOrchestrator.issueAccessKey('aurora-t-1', {
          keyName: 'k',
          permissions: ['read'],
        }),
      ).rejects.toBeInstanceOf(AccessKeyAlreadyExistsError);
    });

    it('maps AuroraValidationError to AccessKeyValidationError and preserves the message', async () => {
      mockCreateAuroraAccessKey.mockRejectedValue(new AuroraValidationError('bad name'));

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
      mockGetAuroraS3Credentials.mockResolvedValue({
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
      expect(mockGetAuroraS3Credentials).toHaveBeenCalledWith('test', 'aurora-t-1');
    });
  });
});
