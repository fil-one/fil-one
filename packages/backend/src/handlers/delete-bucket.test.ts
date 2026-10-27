import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

const mockIsTenantReady = vi.fn();
const mockOrchestratorDeleteBucket = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  deleteBucket: (...args: unknown[]) => mockOrchestratorDeleteBucket(...args),
};

// Records the region it was asked for: routing the delete to the wrong
// orchestrator is the failure this file exists to catch.
const mockGetOrchestratorForRegion = vi.fn((_region: string) => mockOrchestrator);

vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: (region: string) => mockGetOrchestratorForRegion(region),
}));

vi.mock('../lib/org-profile.ts', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler } from './delete-bucket.ts';
import { BucketNotEmptyError } from '../lib/errors.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

const ddbMock = mockClient(DynamoDBClient);

/** The audit events the handler appended, as records. */
function getAuditEvents() {
  return ddbMock
    .commandCalls(PutItemCommand)
    .map((call) => unmarshall(call.args[0].input.Item ?? {}));
}

function deleteEvent(bucketName = 'my-bucket') {
  const event = buildEvent({ userInfo: USER_INFO });
  event.pathParameters = { name: bucketName };
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('delete-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    mockIsTenantReady.mockReturnValue('aurora-t-1');
  });

  it("routes the delete to the bucket's own region", async () => {
    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: 'eu-central-3' },
    });
    event.pathParameters = { name: 'my-bucket' };

    await baseHandler(event);

    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('eu-central-3');
  });

  it('falls back to the default region when the caller names none', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };

    await baseHandler(event);

    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('eu-west-1');
  });

  it('refuses a region this stage does not serve', async () => {
    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: 'ap-south-1' },
    });
    event.pathParameters = { name: 'my-bucket' };

    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual(expect.stringContaining('ap-south-1'));
    expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
    expect(mockOrchestratorDeleteBucket).not.toHaveBeenCalled();
  });

  it('returns 400 when bucket name is missing from path', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 503 when tenant is not ready', async () => {
    mockIsTenantReady.mockReturnValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockOrchestratorDeleteBucket).not.toHaveBeenCalled();
  });

  it('calls orchestrator.deleteBucket and returns 204 with an empty body on success', async () => {
    mockOrchestratorDeleteBucket.mockResolvedValue(undefined);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result).toMatchObject({ statusCode: 204, body: '' });
    expect(mockOrchestratorDeleteBucket).toHaveBeenCalledWith(
      'aurora-t-1',
      'my-bucket',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('passes the tenantId from isTenantReady through to deleteBucket', async () => {
    mockIsTenantReady.mockReturnValue('tenant-xyz');
    mockOrchestratorDeleteBucket.mockResolvedValue(undefined);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'some-bucket' };
    await baseHandler(event);

    expect(mockOrchestratorDeleteBucket).toHaveBeenCalledWith(
      'tenant-xyz',
      'some-bucket',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // A non-empty bucket is the one failure translated to a response here, so the
  // console can tell the user to empty the bucket first.
  it('returns 409 BUCKET_NOT_EMPTY when the bucket still holds objects', async () => {
    mockOrchestratorDeleteBucket.mockRejectedValue(new BucketNotEmptyError('my-bucket'));

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body!) as { message: string; code: string };
    expect(body.code).toBe('BUCKET_NOT_EMPTY');
    expect(body.message).toMatch(/not empty/);
  });

  // Every other failure propagates to errorHandlerMiddleware (which renders the 5xx).
  it('rethrows other failures from the orchestrator', async () => {
    mockOrchestratorDeleteBucket.mockRejectedValue(new Error('S3 gateway unavailable'));

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };

    await expect(baseHandler(event)).rejects.toThrow('S3 gateway unavailable');
  });

  describe('audit', () => {
    it('records a bucket.deleted intent naming the region and bucket before the delete', async () => {
      mockOrchestratorDeleteBucket.mockImplementation(async () => {
        expect(getAuditEvents()).toMatchObject([{ type: 'bucket.deleted', phase: 'intent' }]);
      });

      await baseHandler(deleteEvent());

      expect(getAuditEvents()[0]).toMatchObject({
        type: 'bucket.deleted',
        phase: 'intent',
        actor: { kind: 'user', id: 'user-1' },
        orgId: 'org-1',
        subject: 'bucket:eu-west-1/my-bucket',
        details: { region: 'eu-west-1', bucketName: 'my-bucket' },
      });
    });

    it('completes the bucket.deleted as succeeded when the delete goes through', async () => {
      mockOrchestratorDeleteBucket.mockResolvedValue(undefined);

      await baseHandler(deleteEvent());

      expect(getAuditEvents()[1]).toMatchObject({
        type: 'bucket.deleted',
        phase: 'completion',
        outcome: 'succeeded',
      });
    });

    it.each([
      ['the bucket still holds objects', new BucketNotEmptyError('my-bucket')],
      ['the storage system fails', new Error('S3 gateway unavailable')],
    ])('completes the bucket.deleted as failed when %s', async (_case, err) => {
      mockOrchestratorDeleteBucket.mockRejectedValue(err);

      await baseHandler(deleteEvent()).catch(() => undefined);

      expect(getAuditEvents()[1]).toMatchObject({
        type: 'bucket.deleted',
        phase: 'completion',
        outcome: 'failed',
      });
    });

    it('deletes the bucket even when the audit log cannot be written', async () => {
      ddbMock.on(PutItemCommand).rejects(new Error('audit table unavailable'));
      mockOrchestratorDeleteBucket.mockResolvedValue(undefined);

      const result = await baseHandler(deleteEvent());

      expect(result).toMatchObject({ statusCode: 204 });
    });
  });
});
