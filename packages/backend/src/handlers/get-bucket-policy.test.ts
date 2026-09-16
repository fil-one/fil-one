import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());
vi.mock('../lib/service-orchestrator-registry.ts', async () => {
  const fixture = await import('../test/bucket-policy-fixture.ts');
  return { getOrchestratorForRegion: fixture.orchestratorForRegion };
});
vi.mock('../lib/org-profile.ts', async () => {
  const fixture = await import('../test/bucket-policy-fixture.ts');
  return {
    getOrgProfile: async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } }),
    isOrgDeleting: fixture.isOrgDeleting,
  };
});

import { ApiErrorCode } from '@filone/shared';
import { baseHandler } from './get-bucket-policy.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';
import {
  BUCKET,
  IAM_REGION,
  ORG_ID,
  SCOPED_REGION,
  TENANT_ID,
  USER_ID,
  iam,
  orchestrator,
  readPolicy,
  resetFixture,
} from '../test/bucket-policy-fixture.ts';

function request(region: string = IAM_REGION, name: string = BUCKET) {
  const event = buildEvent({
    userInfo: { userId: USER_ID, orgId: ORG_ID },
    queryStringParameters: { region },
  });
  event.pathParameters = { name };
  return event;
}

const body = (result: { body?: string }) => JSON.parse(result.body ?? '{}');

describe('get-bucket-policy baseHandler', () => {
  beforeEach(resetFixture);

  it('answers the stored document with the ETag the next write must carry', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);

    const result = await baseHandler(request());

    expect(result.statusCode).toBe(200);
    expect(body(result)).toStrictEqual({ policy: readPolicy, etag });
  });

  it('tells a bucket with no policy apart from a bucket that is not there', async () => {
    const none = await baseHandler(request());
    expect(none.statusCode).toBe(404);
    expect(body(none).code).toBe(ApiErrorCode.POLICY_NOT_FOUND);

    const missing = await baseHandler(request(IAM_REGION, 'not-a-bucket'));
    expect(missing.statusCode).toBe(404);
    expect(body(missing).code).toBeUndefined();
  });

  it('answers as a bucket with no policy on a region that serves none, without calling the vendor', async () => {
    const result = await baseHandler(request(SCOPED_REGION));

    expect(result.statusCode).toBe(404);
    expect(body(result).code).toBe(ApiErrorCode.POLICY_NOT_FOUND);
    expect(iam.calls).toHaveLength(0);
  });

  it('answers 503 when the tenant is not provisioned, and never provisions on a read', async () => {
    orchestrator.isTenantReady.mockReturnValueOnce(null);

    const result = await baseHandler(request());

    expect(result.statusCode).toBe(503);
    expect(iam.calls).toHaveLength(0);
  });

  it('requires the bucket name', async () => {
    const event = buildEvent({ userInfo: { userId: USER_ID, orgId: ORG_ID } });
    const result = await baseHandler(event);
    expect(result.statusCode).toBe(400);
  });
});
