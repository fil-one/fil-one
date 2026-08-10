import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';

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
const mockDeleteAuroraAccessKey = vi.fn();
const mockFindAuroraAccessKeyByName = vi.fn();
const mockGetAuroraPortalApiKey = vi.fn();
const mockCreatePortalClient = vi.fn().mockResolvedValue('instrumented-portal-client');

vi.mock('./aurora-portal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../aurora/aurora-portal.js')>();
  return {
    ...original,
    createAuroraBucket: (...args: unknown[]) => mockCreateAuroraBucket(...args),
    createAuroraAccessKey: (...args: unknown[]) => mockCreateAuroraAccessKey(...args),
    deleteAuroraAccessKey: (...args: unknown[]) => mockDeleteAuroraAccessKey(...args),
    findAuroraAccessKeyByName: (...args: unknown[]) => mockFindAuroraAccessKeyByName(...args),
    getAuroraPortalApiKey: (...args: unknown[]) => mockGetAuroraPortalApiKey(...args),
    createPortalClient: (...args: unknown[]) => mockCreatePortalClient(...args),
  };
});

const mockUpdateAuroraTenantStatusApi = vi.fn();
const mockGetAuroraTenantStatusApi = vi.fn();
const mockGetStorageSamples = vi.fn();
const mockGetOperationsSamples = vi.fn();
const mockGetBucketStorageSamples = vi.fn();
const mockGetTenantInfo = vi.fn();
vi.mock('./aurora-backoffice.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../aurora/aurora-backoffice.js')>();
  return {
    ...original,
    updateTenantStatus: (...args: unknown[]) => mockUpdateAuroraTenantStatusApi(...args),
    getTenantStatus: (...args: unknown[]) => mockGetAuroraTenantStatusApi(...args),
    getStorageSamples: (...args: unknown[]) => mockGetStorageSamples(...args),
    getOperationsSamples: (...args: unknown[]) => mockGetOperationsSamples(...args),
    getBucketStorageSamples: (...args: unknown[]) => mockGetBucketStorageSamples(...args),
    getTenantInfo: (...args: unknown[]) => mockGetTenantInfo(...args),
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
process.env.AURORA_PARTNER_ID = 'test-partner';

import { S3Region } from '@filone/shared';
import { auroraOrchestrator, _resetSsmCacheForTesting } from './aurora-orchestrator.js';
import type { OrgProfileItem } from '../org-profile.js';
import { FINAL_SETUP_STATUS, OrgSetupStatus } from '../org-setup-status.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
  BucketNotFoundError,
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
    it('calls the Aurora Portal with the shared instrumented client', async () => {
      mockPortalListBuckets.mockResolvedValue({ data: { items: [] }, error: undefined });

      await auroraOrchestrator.listBuckets('aurora-t-1');

      expect(mockPortalListBuckets).toHaveBeenCalledWith({
        client: 'instrumented-portal-client',
        path: { tenantId: 'aurora-t-1' },
        throwOnError: false,
      });
    });

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

    it('returns versioning:false when includeVersioning is false, even for versioned buckets', async () => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalListBuckets.mockResolvedValue({
        data: {
          items: [
            {
              name: 'b',
              createdAt: '2026-01-02T00:00:00Z',
              flags: ['versioned', 'encrypted'],
            },
          ],
        },
        error: undefined,
      });

      const result = await auroraOrchestrator.listBuckets('aurora-t-1', {
        includeVersioning: false,
      });

      expect(result[0]?.versioning).toBe(false);
      // encrypted is independent of the versioning option.
      expect(result[0]?.encrypted).toBe(true);
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
    it('calls the Aurora Portal with the shared instrumented client', async () => {
      mockPortalGetBucketInfo.mockResolvedValue({
        data: { name: 'b', createdAt: '2026-01-01T00:00:00Z' },
        error: undefined,
        response: { status: 200 },
      });

      await auroraOrchestrator.getBucket('aurora-t-1', 'b');

      expect(mockPortalGetBucketInfo).toHaveBeenCalledWith({
        client: 'instrumented-portal-client',
        path: { tenantId: 'aurora-t-1', bucketName: 'b' },
        throwOnError: false,
      });
    });

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

  describe('deleteTenant', () => {
    const tenantId = 'aurora-t-1';
    const portalApiKeyParam = `/filone/test/aurora-portal/tenant-api-key/${tenantId}`;
    const s3KeyParam = `/filone/test/aurora-s3/access-key/${tenantId}`;

    // deleteTenant probes the status twice per attempt: once to decide the
    // teardown, and once at the end to verify no competing writer re-activated
    // the tenant. Statuses are Aurora's raw ModelsTenantStatus values.
    function mockStatusThenVerify(initial: string, verified = 'DISABLED') {
      mockGetAuroraTenantStatusApi
        .mockResolvedValueOnce({ kind: 'ok', status: initial })
        .mockResolvedValue({ kind: 'ok', status: verified });
    }

    // The whole teardown runs under TENANT_DELETE_RETRY, so a test that drives
    // a failing attempt has to drain the backoff instead of waiting it out in
    // real time. Resolves to the error when deletion rejects, or undefined when
    // it eventually succeeds.
    async function deleteTenantDrainingRetries(): Promise<unknown> {
      vi.useFakeTimers();
      try {
        const settled = auroraOrchestrator.deleteTenant(tenantId).then(
          () => undefined,
          (err: unknown) => err,
        );
        await vi.runAllTimersAsync();
        return await settled;
      } finally {
        vi.useRealTimers();
      }
    }

    // 1 initial attempt + TENANT_DELETE_RETRY's 3 retries.
    const ATTEMPTS = 4;

    // The suite-level hook only clears call history, so a queued
    // mockResolvedValue would otherwise leak across these destructive-path
    // tests and silently change which branch is exercised.
    beforeEach(() => {
      mockGetAuroraTenantStatusApi.mockReset();
      mockUpdateAuroraTenantStatusApi.mockReset();
      mockFindAuroraAccessKeyByName.mockReset();
      mockDeleteAuroraAccessKey.mockReset();
      mockGetAuroraPortalApiKey.mockReset();
    });

    // The 404 branch decides purely on whether FilOne still holds the tenant's
    // two SSM secrets, so every test on that path has to state both. The portal
    // API key is read through the (mocked) module getter; the console S3
    // credentials go through the real getter against the SSM client mock.
    function mockPortalApiKeyInSsm(present: boolean) {
      if (present) {
        mockGetAuroraPortalApiKey.mockResolvedValue('portal-key');
        return;
      }
      mockGetAuroraPortalApiKey.mockRejectedValue(
        new Error(`Aurora API key not found in SSM for tenant ${tenantId}`),
      );
    }

    function mockConsoleCredentialsInSsm(present: boolean) {
      const request = ssmMock.on(GetParameterCommand, {
        Name: s3KeyParam,
        WithDecryption: true,
      });
      if (present) {
        request.resolves({
          Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
        });
        return;
      }
      request.rejects(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    }

    it('disables an active tenant, revokes the console S3 key, and deletes both FilOne-held SSM secrets', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockStatusThenVerify('ACTIVE');
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue({
        id: 'aurora-key-1',
        accessKeyId: 'AKIACONSOLE',
        createdAt: '2026-01-01T00:00:00Z',
      });
      mockDeleteAuroraAccessKey.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      // Aurora has no remote tenant-deletion API — deletion here means the
      // strongest available teardown: disable + upstream key revocation +
      // credential removal.
      expect(mockUpdateAuroraTenantStatusApi).toHaveBeenCalledWith({
        tenantId,
        status: 'DISABLED',
      });
      expect(mockFindAuroraAccessKeyByName).toHaveBeenCalledWith({
        tenantId,
        keyName: 'filone-console',
      });
      expect(mockDeleteAuroraAccessKey).toHaveBeenCalledWith({
        tenantId,
        auroraKeyId: 'aurora-key-1',
      });
      const ssmDeletes = ssmMock
        .commandCalls(DeleteParameterCommand)
        .map((c) => c.args[0].input.Name);
      expect(ssmDeletes).toEqual([portalApiKeyParam, s3KeyParam]);
    });

    it('revokes the console S3 key upstream BEFORE deleting its SSM copies', async () => {
      // Once SSM is cleaned the portal is unreachable and the key id
      // unrecoverable, so revocation must come first.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockStatusThenVerify('ACTIVE');
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue({
        id: 'aurora-key-1',
        accessKeyId: 'AKIACONSOLE',
        createdAt: '2026-01-01T00:00:00Z',
      });
      mockDeleteAuroraAccessKey.mockImplementation(() => {
        expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
        return Promise.resolve();
      });
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(mockDeleteAuroraAccessKey).toHaveBeenCalledTimes(1);
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(2);
    });

    it('tolerates an already-revoked console S3 key (absent from the listing)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(mockDeleteAuroraAccessKey).not.toHaveBeenCalled();
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(2);
    });

    it('skips revocation when the portal API key is already gone from SSM (idempotent re-run)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockRejectedValue(
        new Error(`Aurora API key not found in SSM for tenant ${tenantId}`),
      );
      mockConsoleCredentialsInSsm(false);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await expect(auroraOrchestrator.deleteTenant(tenantId)).resolves.toBeUndefined();

      expect(mockDeleteAuroraAccessKey).not.toHaveBeenCalled();
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(2);
    });

    // Regression: purgeRecords calls deleteTenant a SECOND time in the same
    // pass for late regions, so every ordinary Aurora deletion reaches this
    // branch once — the portal key is already gone. Warning there made the
    // "may still be LIVE upstream" signal permanent noise, which is precisely
    // the signal that has to stand out. Both secrets gone means an earlier
    // pass completed and already reported whatever it observed.
    it('logs rather than warns when BOTH SSM secrets are already gone (the routine repeat pass)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockRejectedValue(
        new Error(`Aurora API key not found in SSM for tenant ${tenantId}`),
      );
      mockConsoleCredentialsInSsm(false);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('an earlier teardown pass completed'),
      );
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).not.toMatch(/could not be attempted or verified/);
      // ...and the summary must not point at a warning that was never emitted.
      expect(warned).not.toMatch(/see the preceding warning/);
    });

    // The genuinely anomalous half-shredded state: the portal API key is gone
    // (so revocation cannot even be attempted) while the console credentials
    // survive, so nothing establishes that the console key was ever revoked.
    // It must not claim a previous run did the work — none necessarily did.
    it('warns that revocation is unverifiable when the portal API key is gone but the console credentials remain', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockRejectedValue(
        new Error(`Aurora API key not found in SSM for tenant ${tenantId}`),
      );
      mockConsoleCredentialsInSsm(true);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not be attempted or verified'),
        { tenantId },
      );
      // Specifically: it must not assert that some earlier run did the work.
      const claimedAlreadyRevoked = [...warnSpy.mock.calls, ...logSpy.mock.calls].some(
        (args) => typeof args[0] === 'string' && /already revoked it/.test(args[0]),
      );
      expect(claimedAlreadyRevoked).toBe(false);
    });

    it('propagates revocation failures and leaves the SSM parameters for the retry', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockResolvedValue({
        id: 'aurora-key-1',
        accessKeyId: 'AKIACONSOLE',
        createdAt: '2026-01-01T00:00:00Z',
      });
      mockDeleteAuroraAccessKey.mockRejectedValue(new Error('portal 500'));

      const err = await deleteTenantDrainingRetries();

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('portal 500');
      expect(mockDeleteAuroraAccessKey).toHaveBeenCalledTimes(ATTEMPTS);
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
    });

    it('warns about the pending manual backoffice deletion after the deletions, before the verification', async () => {
      // Snapshot how much cleanup had executed when the warn fired — the
      // wording must describe work that has already happened.
      let ssmDeletesAtWarnTime = -1;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
        ssmDeletesAtWarnTime = ssmMock.commandCalls(DeleteParameterCommand).length;
      });
      mockStatusThenVerify('ACTIVE');
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('manual backoffice deletion'), {
        tenantId,
      });
      expect(ssmDeletesAtWarnTime).toBe(2);
    });

    // Regression (F2/B5): pass 1 disables and then fails verification, pass 2
    // finds the tenant already disabled. Gating the warning on "this pass
    // disabled the tenant" and placing it after the verification let BOTH
    // passes skip it, so an entire successful teardown finished with nothing
    // anywhere recording that a live Aurora tenant, with all its customer
    // data, still needs a manual backoffice deletion.
    it('warns on a pass that finds the tenant already disabled', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('manual backoffice deletion'), {
        tenantId,
      });
      expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
    });

    it('warns even when the teardown then fails its verification', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockStatusThenVerify('ACTIVE', 'ACTIVE');
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await deleteTenantDrainingRetries();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('manual backoffice deletion'), {
        tenantId,
      });
    });

    it('skips the status update when the tenant is already disabled', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(2);
    });

    // The 404 branch decides from LOCAL evidence only. Corroborating absence
    // upstream was tried and cannot work: probed 2026-08-10 against dev,
    // GetPartner 403s for our token ("Missing permission read:partners"),
    // ListTenants clamps pageSize to 20 against a 239-tenant partner, and
    // GetTenant answers 400 rather than the declared 404 for an id that does
    // not resolve.
    it('treats a 404 with both SSM secrets already gone as an already-complete teardown', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'not_found' });
      mockPortalApiKeyInSsm(false);
      mockConsoleCredentialsInSsm(false);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await expect(auroraOrchestrator.deleteTenant(tenantId)).resolves.toBeUndefined();

      // Nothing to disable, nothing to revoke — and nothing to delete: this is
      // the idempotent-completion exit, not a shred.
      expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
      expect(mockFindAuroraAccessKeyByName).not.toHaveBeenCalled();
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
      // A repeat pass over a finished teardown is not a warning-level event.
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('has already run to completion'));
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // THE safety property of this whole branch. getTenantStatus maps ANY 404 to
    // not_found, so a wrong AURORA_PARTNER_ID / baseUrl / token 404s a tenant
    // that is still live and ACTIVE upstream. Deleting its SSM secrets is
    // unrecoverable — processTenantSetup will not re-mint them — so the count
    // of DeleteParameter calls must be exactly zero in every state where
    // FilOne still holds a secret.
    const heldSecretCases: Record<string, { portal: boolean; console: boolean }> = {
      'both secrets are still held': { portal: true, console: true },
      'only the portal API key is still held': { portal: true, console: false },
      'only the console S3 credentials are still held': { portal: false, console: true },
    };

    for (const [desc, held] of Object.entries(heldSecretCases)) {
      it(`refuses to delete any SSM parameter on a 404 when ${desc}`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'not_found' });
        mockPortalApiKeyInSsm(held.portal);
        mockConsoleCredentialsInSsm(held.console);
        ssmMock.on(DeleteParameterCommand).resolves({});

        const err = await deleteTenantDrainingRetries();

        expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
        expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
        const message = (err as Error).message;
        expect(message).toMatch(/will NOT delete its credentials on an unexplained 404/);
        // The operator remediation has to be actionable: it names the exact
        // parameters whose manual deletion unwedges the next pass.
        if (held.portal) expect(message).toContain(portalApiKeyParam);
        else expect(message).not.toContain(portalApiKeyParam);
        if (held.console) expect(message).toContain(s3KeyParam);
        else expect(message).not.toContain(s3KeyParam);
        expect(message).toMatch(/delete (that parameter|those parameters) by hand/);
      });
    }

    // "We could not read the parameter" must never be taken for "it is gone":
    // only SSM's ParameterNotFound counts as absence.
    it('propagates a non-ParameterNotFound SSM failure instead of reading it as absence', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'not_found' });
      mockGetAuroraPortalApiKey.mockRejectedValue(
        Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }),
      );
      mockConsoleCredentialsInSsm(false);
      ssmMock.on(DeleteParameterCommand).resolves({});

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('User is not authorized');
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
    });

    // The trial-lock enforcer in usage-reporting-worker is unfenced and
    // region-helpers allows `disabled -> active`, so a competing writer can
    // undo the teardown. Aurora has no upstream DELETE to converge on, so the
    // only defense is to notice and let the retry re-disable.
    it('re-disables and succeeds when a competing writer re-activated the tenant mid-teardown', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi
        // attempt 1: probe ACTIVE, verify still ACTIVE (re-activated)
        .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
        .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
        // attempt 2: probe ACTIVE again, verify DISABLED
        .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
        .mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await expect(deleteTenantDrainingRetries()).resolves.toBeUndefined();

      // Re-disabled on the second attempt rather than giving up.
      expect(mockUpdateAuroraTenantStatusApi).toHaveBeenCalledTimes(2);
    });

    it('throws when a competing writer holds the tenant active past the retry budget', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockStatusThenVerify('ACTIVE', 'ACTIVE');
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain(
        `Aurora tenant ${tenantId} could not be confirmed DISABLED after teardown`,
      );
      expect((err as Error).message).toContain('a competing writer re-activated it');
      // The consequence has to be stated where it is observed.
      expect((err as Error).message).toContain("account's data purge is blocked");
    });

    // Regression (B2): the orchestrator-facing mapping turns Aurora's LOCKED
    // into `undefined`, which used to be reported as "a competing writer
    // re-activated it" — a claim the probe cannot support, on a state no
    // retry can exit, which under the fatal-throw semantics means the org's
    // personal data is never purged.
    it('names LOCKED as an operator-only state rather than blaming a competing writer', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockStatusThenVerify('ACTIVE', 'LOCKED');
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('status=LOCKED');
      expect((err as Error).message).toContain('an operator must set it to DISABLED by hand');
      expect((err as Error).message).not.toContain('competing writer re-activated');
      // The retry DOES re-issue the disable (any status other than DISABLED is
      // PATCHed), so claiming "retrying will not change it" was wrong.
      expect((err as Error).message).toContain('The retry does re-issue the disable');
      expect(mockUpdateAuroraTenantStatusApi).toHaveBeenCalledTimes(ATTEMPTS);
    });

    it('names a missing status field as an operator-only state', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // `{ kind: 'ok' }` with no status at all — distinct from LOCKED, which
      // the orchestrator-facing mapping used to collapse into the same value.
      mockGetAuroraTenantStatusApi
        .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
        .mockResolvedValue({ kind: 'ok' });
      mockUpdateAuroraTenantStatusApi.mockResolvedValue(undefined);
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('no tenant status field at all');
      expect((err as Error).message).not.toContain('competing writer re-activated');
    });

    // The tenant resolved seconds earlier, so a 404 on the verification probe
    // means the client broke — not that the tenant is gone.
    it('throws when the post-teardown verification probe 404s', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Every attempt: the opening probe resolves the tenant, the closing
      // verification 404s. Only the verification's 404 is under test here.
      let probeCall = 0;
      mockGetAuroraTenantStatusApi.mockImplementation(() => {
        probeCall += 1;
        return Promise.resolve(
          probeCall % 2 === 1 ? { kind: 'ok', status: 'DISABLED' } : { kind: 'not_found' },
        );
      });
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('stopped resolving mid-teardown');
      expect((err as Error).message).not.toContain('competing writer re-activated');
    });

    // A transient 5xx on the verification is now absorbed in-process rather
    // than escalating into a blocked account purge.
    it('retries through a transient verification failure and succeeds', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetAuroraTenantStatusApi
        .mockResolvedValueOnce({ kind: 'ok', status: 'DISABLED' })
        .mockResolvedValueOnce({ kind: 'error', cause: new Error('backoffice 503') })
        .mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      ssmMock.on(DeleteParameterCommand).resolves({});

      await expect(deleteTenantDrainingRetries()).resolves.toBeUndefined();
    });

    it('evicts the cached portal API key so warm containers stop serving it', async () => {
      // The aurora-portal mock spreads the original module, so deleteTenant
      // runs the real deleteAuroraPortalApiKey against the real cache.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const portal =
        await vi.importActual<typeof import('./aurora-portal.js')>('./aurora-portal.js');
      ssmMock
        .on(GetParameterCommand, { Name: portalApiKeyParam, WithDecryption: true })
        .resolves({ Parameter: { Value: 'portal-key' } });
      await portal.getAuroraPortalApiKey('test', tenantId); // prime the cache
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      ssmMock.on(DeleteParameterCommand).resolves({});

      await auroraOrchestrator.deleteTenant(tenantId);

      // A cache hit would serve the stale key without touching SSM; the
      // eviction surfaces as a re-fetch that now finds the parameter gone.
      ssmMock
        .on(GetParameterCommand)
        .rejects(Object.assign(new Error('gone'), { name: 'ParameterNotFound' }));
      await expect(portal.getAuroraPortalApiKey('test', tenantId)).rejects.toThrow(
        `Aurora API key not found in SSM for tenant ${tenantId}`,
      );
    });

    it('tolerates already-deleted SSM parameters (idempotent re-run)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      // The tenant still resolves (Aurora has no remote DELETE), so this is the
      // ordinary teardown path re-run after its secrets are already gone.
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });
      mockFindAuroraAccessKeyByName.mockResolvedValue(undefined);
      mockConsoleCredentialsInSsm(false);
      ssmMock
        .on(DeleteParameterCommand)
        .rejects(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));

      await expect(auroraOrchestrator.deleteTenant(tenantId)).resolves.toBeUndefined();
    });

    it('throws when the status probe fails, leaving everything for the retry', async () => {
      const cause = new Error('backoffice down');
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'error', cause });

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain(
        `Aurora status probe failed while deleting tenant ${tenantId}`,
      );
      expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
    });
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
        orchestratorId: 'aurora',
        tenantId: 'aurora-t-1',
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

  describe('getTenantInfo', () => {
    it('maps backoffice tenant info, applying defaults for missing fields', async () => {
      mockGetTenantInfo.mockResolvedValue({
        bucketCount: 2,
        bucketQuantityLimit: 50,
        keyCount: 3,
        accessKeyQuantityLimit: 200,
        status: 'ACTIVE',
      });

      const result = await auroraOrchestrator.getTenantInfo('aurora-t-1');

      expect(result).toEqual({
        bucketCount: 2,
        bucketLimit: 50,
        keyCount: 3,
        accessKeyLimit: 200,
        status: 'active',
      });
      expect(mockGetTenantInfo).toHaveBeenCalledWith({ tenantId: 'aurora-t-1' });
    });

    it('falls back to 100 / 300 limits when the backoffice omits them', async () => {
      mockGetTenantInfo.mockResolvedValue({});

      const result = await auroraOrchestrator.getTenantInfo('aurora-t-1');

      expect(result).toEqual({
        bucketCount: 0,
        bucketLimit: 100,
        keyCount: 0,
        accessKeyLimit: 300,
        status: undefined,
      });
    });

    it.each([
      ['ACTIVE', 'active'],
      ['WRITE_LOCKED', 'write-locked'],
      ['DISABLED', 'disabled'],
      ['LOCKED', undefined],
      [undefined, undefined],
      ['unknown', undefined],
    ])('normalizes backoffice status %s -> %s', async (status, expected) => {
      mockGetTenantInfo.mockResolvedValue({ status });

      const result = await auroraOrchestrator.getTenantInfo('aurora-t-1');

      expect(result.status).toBe(expected);
    });
  });

  describe('getBucketUsageMetrics', () => {
    const FROM = '2026-01-01T00:00:00Z';
    const TO = '2026-01-31T00:00:00Z';

    // getBucketUsageMetrics gates the (globally-scoped) storage query behind a
    // tenant-scoped getBucket ownership check, so by default resolve the bucket.
    beforeEach(() => {
      mockGetAuroraPortalApiKey.mockResolvedValue('api-key');
      mockPortalGetBucketInfo.mockResolvedValue({
        data: { name: 'my-bucket', createdAt: '2026-01-01T00:00:00Z' },
        error: undefined,
        response: { status: 200 },
      });
    });

    it('throws BucketNotFoundError when the bucket is not owned by the tenant', async () => {
      mockPortalGetBucketInfo.mockResolvedValue({
        data: undefined,
        error: { message: 'not found' },
        response: { status: 404 },
      });

      await expect(
        auroraOrchestrator.getBucketUsageMetrics('aurora-t-1', 'other-orgs-bucket', {
          from: FROM,
          to: TO,
        }),
      ).rejects.toThrow(BucketNotFoundError);
      expect(mockGetBucketStorageSamples).not.toHaveBeenCalled();
    });

    it('forwards bucketName/from/to/window and maps samples with ?? 0 defaults', async () => {
      mockGetBucketStorageSamples.mockResolvedValue([
        { timestamp: '2026-01-01T01:00:00Z', bytesUsed: 1024, objectCount: 5 },
        { timestamp: '2026-01-01T02:00:00Z' },
      ]);

      const result = await auroraOrchestrator.getBucketUsageMetrics('aurora-t-1', 'my-bucket', {
        from: FROM,
        to: TO,
        interval: '1d',
      });

      expect(mockGetBucketStorageSamples).toHaveBeenCalledWith({
        bucketName: 'my-bucket',
        from: FROM,
        to: TO,
        window: '24h',
      });
      expect(result).toEqual([
        { timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 1024, objectCount: 5 },
        { timestamp: '2026-01-01T02:00:00.000Z', bytesUsed: 0, objectCount: 0 },
      ]);
    });

    it('returns an empty array when the bucket has no samples', async () => {
      mockGetBucketStorageSamples.mockResolvedValue([]);

      const result = await auroraOrchestrator.getBucketUsageMetrics('aurora-t-1', 'my-bucket', {
        from: FROM,
        to: TO,
      });

      expect(result).toEqual([]);
    });
  });
});
