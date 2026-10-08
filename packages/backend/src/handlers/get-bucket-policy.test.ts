import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());
vi.mock('../lib/service-orchestrator-registry.ts', async () => {
  const fixture = await import('../test/bucket-policy-fixture.ts');
  return { getOrchestratorForRegion: fixture.getOrchestratorForRegion };
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
  BUCKET_NAME,
  IAM_REGION,
  ORG_ID,
  SCOPED_KEYS_REGION,
  TENANT_ID,
  USER_ID,
  ensureTenantReady,
  grantGetObjectToUser,
  iam,
  orchestrator,
  resetFixture,
} from '../test/bucket-policy-fixture.ts';

function buildGetEvent(region: string = IAM_REGION, name: string = BUCKET_NAME) {
  const event = buildEvent({
    userInfo: { userId: USER_ID, orgId: ORG_ID },
    queryStringParameters: { region },
  });
  event.pathParameters = { name };
  return event;
}

const parseResponseBody = (result: { body?: string }) => JSON.parse(result.body ?? '{}');

describe('get-bucket-policy baseHandler', () => {
  beforeEach(resetFixture);

  it('answers the stored document with the ETag the next write must carry as a header', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildGetEvent());

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 200,
      headers: { ETag: etag },
      body: { policy: grantGetObjectToUser },
    });
  });

  it('answers 404 POLICY_NOT_FOUND for a bucket with no policy', async () => {
    const result = await baseHandler(buildGetEvent());

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 404,
      body: { code: ApiErrorCode.POLICY_NOT_FOUND },
    });
  });

  it('answers 404 without a code for a bucket that does not exist', async () => {
    const result = await baseHandler(buildGetEvent(IAM_REGION, 'not-a-bucket'));

    expect({ statusCode: result.statusCode, body: parseResponseBody(result) }).toStrictEqual({
      statusCode: 404,
      body: { message: 'Bucket not found' },
    });
  });

  it('answers 404 POLICY_NOT_FOUND in a region without the iam access model', async () => {
    const result = await baseHandler(buildGetEvent(SCOPED_KEYS_REGION));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 404,
      body: { code: ApiErrorCode.POLICY_NOT_FOUND },
    });
    expect(iam.calls).toHaveLength(0);
  });

  it('answers 503 when the tenant is not provisioned', async () => {
    orchestrator.isTenantReady.mockReturnValueOnce(null);

    const result = await baseHandler(buildGetEvent());

    expect(result.statusCode).toBe(503);
    expect(iam.calls).toHaveLength(0);
  });

  it('does not provision a tenant on a read', async () => {
    orchestrator.isTenantReady.mockReturnValueOnce(null);

    await baseHandler(buildGetEvent());

    expect(ensureTenantReady).not.toHaveBeenCalled();
  });

  it('answers 400 when the path has no bucket name', async () => {
    const event = buildEvent({ userInfo: { userId: USER_ID, orgId: ORG_ID } });

    const result = await baseHandler(event);

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message: 'Bucket name is required' },
    });
  });
});
