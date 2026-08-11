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
    // mockResolvedValue would otherwise leak across these tests and silently
    // change which branch is exercised.
    beforeEach(() => {
      mockGetAuroraTenantStatusApi.mockReset();
      mockUpdateAuroraTenantStatusApi.mockReset();
    });

    it('disables an active tenant and verifies it stayed disabled', async () => {
      mockStatusThenVerify('ACTIVE');

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(mockUpdateAuroraTenantStatusApi).toHaveBeenCalledWith({
        tenantId,
        status: 'DISABLED',
      });
      // Nothing is destroyed: the FilOne-held SSM secrets are the only route
      // back to this tenant's Portal, and FIL-919's deferred data deletion
      // needs them.
      expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
      expect(mockDeleteAuroraAccessKey).not.toHaveBeenCalled();
    });

    it('skips the status update when the tenant is already disabled', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'DISABLED' });

      await auroraOrchestrator.deleteTenant(tenantId);

      expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
    });

    it('treats a tenant Aurora cannot resolve as nothing left to do', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'not_found' });

      await expect(auroraOrchestrator.deleteTenant(tenantId)).resolves.toBeUndefined();

      expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
    });

    it('throws when the status probe fails, leaving everything for the retry', async () => {
      const cause = new Error('backoffice down');
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'error', cause });

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain(
        `Aurora status probe failed while deleting tenant ${tenantId}`,
      );
      expect(mockUpdateAuroraTenantStatusApi).not.toHaveBeenCalled();
    });

    // The verification is now the WHOLE of this teardown's fail-closed
    // behaviour, so each of its branches has to keep failing closed.
    it('re-disables and succeeds when a competing writer re-activated the tenant mid-teardown', async () => {
      // attempt 1: probe ACTIVE -> disable -> verify still ACTIVE -> throw.
      // attempt 2: probe ACTIVE -> disable again -> verify DISABLED -> success.
      mockGetAuroraTenantStatusApi
        .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
        .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
        .mockResolvedValueOnce({ kind: 'ok', status: 'ACTIVE' })
        .mockResolvedValue({ kind: 'ok', status: 'DISABLED' });

      await expect(deleteTenantDrainingRetries()).resolves.toBeUndefined();

      expect(mockUpdateAuroraTenantStatusApi).toHaveBeenCalledTimes(2);
    });

    it('throws when a competing writer holds the tenant active past the retry budget', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'ACTIVE' });

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('could not be confirmed DISABLED after teardown');
      expect((err as Error).message).toContain('a competing writer re-activated it');
      expect(mockUpdateAuroraTenantStatusApi).toHaveBeenCalledTimes(ATTEMPTS);
    });

    it('names LOCKED as an operator-only state rather than blaming a competing writer', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: 'LOCKED' });

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('read-only rather than disabled');
      expect((err as Error).message).toContain('an operator must set DISABLED by hand');
    });

    it('names a missing status field as an operator-only state', async () => {
      mockGetAuroraTenantStatusApi.mockResolvedValue({ kind: 'ok', status: undefined });

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('no tenant status field at all');
      expect((err as Error).message).toContain('needs an operator, not a retry');
    });

    it('throws when the post-teardown verification probe 404s', async () => {
      // Alternating, because a `not_found` on the OPENING probe is now success:
      // every attempt must resolve the tenant and then lose it at the verify.
      let call = 0;
      mockGetAuroraTenantStatusApi.mockImplementation(() =>
        Promise.resolve(
          ++call % 2 === 1 ? { kind: 'ok', status: 'ACTIVE' } : { kind: 'not_found' },
        ),
      );

      const err = await deleteTenantDrainingRetries();

      expect((err as Error).message).toContain('could not be confirmed DISABLED after teardown');
      expect((err as Error).message).toContain('stopped resolving mid-teardown');
    });

    // A transient 5xx on the verification is absorbed in-process rather than
    // escalating into a blocked account purge.
    it('retries through a transient verification failure and succeeds', async () => {
      mockGetAuroraTenantStatusApi
        .mockResolvedValueOnce({ kind: 'ok', status: 'DISABLED' })
        .mockResolvedValueOnce({ kind: 'error', cause: new Error('backoffice 503') })
        .mockResolvedValue({ kind: 'ok', status: 'DISABLED' });

      await expect(deleteTenantDrainingRetries()).resolves.toBeUndefined();
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
