import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());
vi.mock('../lib/service-orchestrator-registry.ts', async () => {
  const fixture = await import('../test/bucket-policy-fixture.ts');
  return { getOrchestratorForRegion: fixture.orchestratorForRegion };
});
vi.mock('../lib/org-profile.ts', async () => {
  const fixture = await import('../test/bucket-policy-fixture.ts');
  return { isOrgDeleting: fixture.isOrgDeleting };
});

import { ApiErrorCode } from '@filone/shared';
import { baseHandler } from './delete-bucket-policy.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';
import {
  BUCKET,
  IAM_REGION,
  ORG_ID,
  TENANT_ID,
  USER_ID,
  auditEvents,
  iam,
  readPolicy,
  resetFixture,
} from '../test/bucket-policy-fixture.ts';

function request(query: Record<string, string>) {
  const event = buildEvent({
    method: 'DELETE',
    userInfo: { userId: USER_ID, orgId: ORG_ID },
    queryStringParameters: { region: IAM_REGION, ...query },
  });
  event.pathParameters = { name: BUCKET };
  return event;
}

const body = (result: { body?: string }) => JSON.parse(result.body ?? '{}');

describe('delete-bucket-policy baseHandler', () => {
  beforeEach(resetFixture);

  it('removes the policy the caller read and records the pair', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);

    const result = await baseHandler(request({ etag }));

    expect(result.statusCode).toBe(204);
    expect(iam.policies.get(TENANT_ID)?.has(BUCKET)).toBe(false);
    const [intent, completion] = auditEvents();
    expect(intent).toMatchObject({ type: 'bucket_policy.deleted', phase: 'intent' });
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'succeeded' });
  });

  it('requires the etag of the document being removed', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);

    const result = await baseHandler(request({}));

    expect(result.statusCode).toBe(400);
    expect(iam.calls).toHaveLength(0);
  });

  it('refuses a stale etag with the policy still in place', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);

    const result = await baseHandler(request({ etag: '"stale"' }));

    expect(result.statusCode).toBe(409);
    expect(body(result).code).toBe(ApiErrorCode.POLICY_CONFLICT);
    expect(iam.policies.get(TENANT_ID)?.has(BUCKET)).toBe(true);
  });

  it('answers 404 with the policy code for a bucket that has none', async () => {
    const result = await baseHandler(request({ etag: '"any"' }));

    expect(result.statusCode).toBe(404);
    expect(body(result).code).toBe(ApiErrorCode.POLICY_NOT_FOUND);
  });
});
