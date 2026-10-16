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
import { baseHandler } from './delete-bucket-policy.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';
import {
  BUCKET_NAME,
  IAM_REGION,
  ORG_ID,
  SERVICE_KEYS_REGION,
  TENANT_ID,
  USER_ID,
  ensureTenantReady,
  getAuditEvents,
  iam,
  grantGetObjectToUser,
  orchestrator,
  resetFixture,
} from '../test/bucket-policy-fixture.ts';

function buildDeleteEvent(headers: Record<string, string>, region: string = IAM_REGION) {
  const event = buildEvent({
    method: 'DELETE',
    userInfo: { userId: USER_ID, orgId: ORG_ID },
    queryStringParameters: { region },
  });
  event.headers = headers;
  event.pathParameters = { name: BUCKET_NAME };
  return event;
}

const parseResponseBody = (result: { body?: string }) => JSON.parse(result.body ?? '{}');

describe('delete-bucket-policy baseHandler', () => {
  beforeEach(resetFixture);

  it('removes the policy matching If-Match', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildDeleteEvent({ 'if-match': etag }));

    expect(result).toMatchObject({
      statusCode: 204,
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Strict-Transport-Security': 'max-age=2592000; includeSubDomains',
      },
      body: '',
    });
    expect(iam.policies.get(TENANT_ID)?.has(BUCKET_NAME)).toBe(false);
  });

  it('records a deleted intent and a succeeded completion', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    await baseHandler(buildDeleteEvent({ 'if-match': etag }));

    const [intent, completion] = getAuditEvents();
    expect(intent).toMatchObject({
      type: 'bucket_policy.deleted',
      phase: 'intent',
      details: { region: IAM_REGION, bucketName: BUCKET_NAME, trigger: 'policy_edited' },
    });
    expect(completion).toMatchObject({
      type: 'bucket_policy.deleted',
      phase: 'completion',
      outcome: 'succeeded',
      correlationId: intent!.correlationId,
    });
  });

  it('removes the policy unconditionally without If-Match, as on S3', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildDeleteEvent({}));

    expect(result.statusCode).toBe(204);
    expect(iam.policies.get(TENANT_ID)?.has(BUCKET_NAME)).toBe(false);
  });

  it('refuses If-None-Match, since a delete creates nothing', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildDeleteEvent({ 'if-none-match': '*' }));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message: 'A delete cannot carry If-None-Match' },
    });
    expect(iam.calls).toHaveLength(0);
  });

  it('refuses a stale If-Match with the policy still in place', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildDeleteEvent({ 'if-match': '"stale"' }));

    expect(result.statusCode).toBe(412);
    expect(parseResponseBody(result).code).toBe(ApiErrorCode.POLICY_CONFLICT);
    expect(iam.policies.get(TENANT_ID)?.has(BUCKET_NAME)).toBe(true);
  });

  it('answers 404 with the policy code for a bucket that has none', async () => {
    const result = await baseHandler(buildDeleteEvent({ 'if-match': '"any"' }));

    expect(result.statusCode).toBe(404);
    expect(parseResponseBody(result).code).toBe(ApiErrorCode.POLICY_NOT_FOUND);
  });

  it('answers 503 without provisioning a tenant when the org has none in the region', async () => {
    orchestrator.isTenantReady.mockReturnValueOnce(null);

    const result = await baseHandler(buildDeleteEvent({ 'if-match': '"v1"' }));

    expect(result.statusCode).toBe(503);
    expect(iam.calls).toHaveLength(0);
    expect(ensureTenantReady).not.toHaveBeenCalled();
  });

  it('answers 501 in a region whose network does not serve the iam access model', async () => {
    const result = await baseHandler(
      buildDeleteEvent({ 'if-match': '"any"' }, SERVICE_KEYS_REGION),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 501,
      body: { message: 'Bucket policies are not available in this region' },
    });
    expect(iam.calls).toHaveLength(0);
  });
});
