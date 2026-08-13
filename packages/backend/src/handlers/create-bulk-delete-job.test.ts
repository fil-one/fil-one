import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region } from '@filone/shared';

import type { BulkDeleteJobRecord } from '../lib/dynamo-records.js';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BulkDeleteTable: { name: 'BulkDeleteTable' },
    BulkDeleteWorker: { name: 'BulkDeleteWorker' },
  },
}));

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = sendMock;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

const mockIsTenantReady = vi.fn<() => string | undefined>(() => 'tenant-1');
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: () => ({ isTenantReady: () => mockIsTenantReady() }),
}));
vi.mock('../lib/org-profile.js', () => ({ getOrgProfile: vi.fn(async () => ({})) }));

vi.mock('../lib/bulk-delete-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-jobs.js')>();
  return { ...actual, createBulkDeleteJob: vi.fn() };
});

process.env.FILONE_STAGE = 'test';

import { BulkDeleteJobExistsError, createBulkDeleteJob } from '../lib/bulk-delete-jobs.js';
import { baseHandler } from './create-bulk-delete-job.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const mockCreate = vi.mocked(createBulkDeleteJob);

const idempotencyKey = '3f1a6b2c-8d4e-4f0a-9b3c-1d2e3f4a5b6c';

function record(overrides: Partial<BulkDeleteJobRecord> = {}): BulkDeleteJobRecord {
  return {
    pk: 'BULKDELETE#org-1',
    sk: `JOB#${idempotencyKey}`,
    jobId: idempotencyKey,
    orgId: 'org-1',
    region: S3Region.EuWest1,
    bucketName: 'my-bucket',
    prefix: '',
    scope: BulkDeleteScope.AllVersions,
    status: BulkDeleteJobStatus.Pending,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    multiDelete: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ttl: 1,
    ...overrides,
  };
}

function event(
  body: unknown,
  bucketName: string | null = 'my-bucket',
  region: string = S3Region.EuWest1,
) {
  const built = buildEvent({
    method: 'POST',
    queryStringParameters: { region },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    userInfo: { orgId: 'org-1', userId: 'user-1' },
  });
  if (bucketName) built.pathParameters = { name: bucketName };
  return built;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsTenantReady.mockReturnValue('tenant-1');
  mockCreate.mockResolvedValue(record());
});

describe('create-bulk-delete-job', () => {
  it('creates a job and hands it to the worker', async () => {
    const result = await baseHandler(event({ idempotencyKey }));

    expect(result.statusCode).toBe(202);
    expect(JSON.parse(result.body!).job.jobId).toBe(idempotencyKey);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('uses the idempotency key as the job id', async () => {
    await baseHandler(event({ idempotencyKey }));
    expect(mockCreate.mock.calls[0][0].jobId).toBe(idempotencyKey);
  });

  it('defaults to the whole bucket and all versions', async () => {
    await baseHandler(event({ idempotencyKey }));
    const args = mockCreate.mock.calls[0][0];
    expect(args.prefix).toBe('');
    expect(args.scope).toBe(BulkDeleteScope.AllVersions);
  });

  it('passes an explicit prefix and scope through', async () => {
    await baseHandler(event({ idempotencyKey, prefix: 'photos/', scope: BulkDeleteScope.Current }));
    const args = mockCreate.mock.calls[0][0];
    expect(args.prefix).toBe('photos/');
    expect(args.scope).toBe(BulkDeleteScope.Current);
  });

  it('returns the running job for a duplicate submit without starting another', async () => {
    const existing = record({ status: BulkDeleteJobStatus.Running, deletedCount: 40 });
    mockCreate.mockRejectedValue(new BulkDeleteJobExistsError(existing));

    const result = await baseHandler(event({ idempotencyKey }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!).job.deletedCount).toBe(40);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no idempotency key', async () => {
    const result = await baseHandler(event({}));
    expect(result.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    const result = await baseHandler(event('not json'));
    expect(result.statusCode).toBe(400);
  });

  it('requires a bucket name', async () => {
    const result = await baseHandler(event({ idempotencyKey }, null));
    expect(result.statusCode).toBe(400);
  });

  it('rejects an unsupported region', async () => {
    const result = await baseHandler(event({ idempotencyKey }, 'my-bucket', 'mars-1'));
    expect(result.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses when the tenant is not provisioned', async () => {
    mockIsTenantReady.mockReturnValue(undefined);
    const result = await baseHandler(event({ idempotencyKey }));
    expect(result.statusCode).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
