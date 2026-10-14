import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

vi.mock('sst', () => ({ Resource: { UserInfoTable: { name: 'UserInfoTable' } } }));

// The generated SDK is mocked at the module boundary; each operation answers
// the hey-api `{ data, error, response }` shape.
const mockPutPrincipal = vi.fn((_o: Record<string, unknown>) => ({}));
const mockDeletePrincipal = vi.fn((_o: Record<string, unknown>) => ({}));
const mockListPrincipalPolicies = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetPrincipalAccess = vi.fn((_o: Record<string, unknown>) => ({}));

vi.mock('@filone/orchestrator-client', () => ({
  createClient: () => 'mock-client',
  putTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) => mockPutPrincipal(o),
  deleteTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) =>
    mockDeletePrincipal(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdPolicies: (o: Record<string, unknown>) =>
    mockListPrincipalPolicies(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess: (o: Record<string, unknown>) =>
    mockGetPrincipalAccess(o),
}));
vi.mock('./metrics.ts', () => ({ instrumentClient: vi.fn() }));

import { PolicyValidationError } from '../errors.ts';
import { FilOneOrchestrator } from './orchestrator.ts';

const ALICE = '00000000-0000-0000-0000-00000000000a';
/** A principal the storage system does not know. */
const GHOST = '00000000-0000-0000-0000-0000000000ee';

const tenantId = '00000000-0000-0000-0000-000000000001';
const policy: BucketPolicy = {
  Statement: [{ Effect: 'Allow', Principal: [ALICE], Action: ['s3:GetObject'] }],
};

// The hey-api SDK resolves every call to `{ data, error, response }` rather than throwing.
function buildSdkResult(
  status: number,
  data?: unknown,
  error?: unknown,
  headers: Record<string, string> = {},
) {
  return { data, error, response: { status, headers: new Headers(headers) } };
}
const ok = (data: unknown, status = 200, headers?: Record<string, string>) =>
  buildSdkResult(status, data, undefined, headers);
const fail = (status: number, body: unknown = { message: 'error' }) =>
  buildSdkResult(status, undefined, body);

const orchestrator = new FilOneOrchestrator({
  id: 'forge',
  region: S3Region.UsEast9,
  stage: 'test',
  s3EndpointUrl: 'https://s3.example.test',
  api: { baseUrl: 'https://api.example.test', accessToken: 'partner-key' },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('principals', () => {
  it.each([201, 200])('syncMember resolves when the principal PUT answers %i', async (status) => {
    mockPutPrincipal.mockResolvedValueOnce(ok({ principalId: ALICE }, status));
    await expect(orchestrator.syncMember(tenantId, ALICE)).resolves.toBeUndefined();
    expect(mockPutPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId, principalId: ALICE } }),
    );
  });

  it('syncMember throws PolicyValidationError when the storage system answers 422', async () => {
    mockPutPrincipal.mockResolvedValue(fail(422, { message: 'invalid principal id' }));
    await expect(orchestrator.syncMember(tenantId, '*')).rejects.toBeInstanceOf(
      PolicyValidationError,
    );
  });

  it('removeMember resolves when the storage system answers 204', async () => {
    mockDeletePrincipal.mockResolvedValueOnce(buildSdkResult(204));
    await expect(orchestrator.removeMember(tenantId, ALICE)).resolves.toBeUndefined();
  });

  it('removeMember throws when the tenant is missing', async () => {
    mockDeletePrincipal.mockResolvedValueOnce(fail(404));
    await expect(orchestrator.removeMember(tenantId, ALICE)).rejects.toThrow(
      `Failed to remove principal "${ALICE}" for forge tenant ${tenantId}: the tenant does not exist`,
    );
  });

  it('listBucketPoliciesForMember returns each bucket with its policy', async () => {
    mockListPrincipalPolicies.mockResolvedValue(ok({ items: [{ bucketName: 'photos', policy }] }));

    await expect(orchestrator.listBucketPoliciesForMember(tenantId, ALICE)).resolves.toStrictEqual([
      { bucketName: 'photos', policy },
    ]);
  });

  it('resolveMemberAccess returns each bucket with the member’s actions', async () => {
    mockGetPrincipalAccess.mockResolvedValue(
      ok({ buckets: [{ name: 'photos', actions: ['s3:GetObject'] }] }),
    );

    await expect(orchestrator.resolveMemberAccess(tenantId, ALICE)).resolves.toStrictEqual([
      { bucketName: 'photos', actions: ['s3:GetObject'] },
    ]);
  });

  it.each([
    {
      read: 'listBucketPoliciesForMember',
      arrange: () => mockListPrincipalPolicies.mockResolvedValue(fail(404)),
      call: () => orchestrator.listBucketPoliciesForMember(tenantId, GHOST),
    },
    {
      read: 'resolveMemberAccess',
      arrange: () => mockGetPrincipalAccess.mockResolvedValue(fail(404)),
      call: () => orchestrator.resolveMemberAccess(tenantId, GHOST),
    },
  ])(
    '$read answers nothing for a principal the storage system does not know',
    async ({ arrange, call }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      arrange();

      try {
        await expect(call()).resolves.toStrictEqual([]);
      } finally {
        warn.mockRestore();
      }
    },
  );
});
