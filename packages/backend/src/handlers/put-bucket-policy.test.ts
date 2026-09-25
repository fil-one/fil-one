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

import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { BucketPolicy, PolicyStatement } from '@filone/shared';
import { PolicyPublishError } from '../lib/errors.ts';
import { baseHandler } from './put-bucket-policy.ts';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.ts';
import {
  BUCKET,
  IAM_REGION,
  ORG_ID,
  SCOPED_REGION,
  TENANT_ID,
  USER_ID,
  auditEvents,
  ensureTenantReady,
  iam,
  isOrgDeleting,
  readPolicy,
  resetFixture,
} from '../test/bucket-policy-fixture.ts';

function request(
  payload: { policy: BucketPolicy; etag?: string },
  { region = IAM_REGION, role = OrgRole.Owner }: { region?: string; role?: OrgRole } = {},
) {
  const event = buildEvent({
    method: 'PUT',
    body: JSON.stringify(payload),
    userInfo: {
      userId: USER_ID,
      orgId: ORG_ID,
      email: 'owner@example.com',
      membership: membershipFor(ORG_ID, USER_ID, role),
    },
    queryStringParameters: { region },
  });
  event.pathParameters = { name: BUCKET };
  return event;
}

const body = (result: { body?: string }) => JSON.parse(result.body ?? '{}');

const retentionGrant: BucketPolicy = {
  statement: [{ effect: 'allow', principal: [USER_ID], action: ['s3:PutObjectRetention'] }],
};

describe('put-bucket-policy baseHandler', () => {
  beforeEach(resetFixture);

  it('creates the first policy without an etag and answers 201 with the new one', async () => {
    const result = await baseHandler(request({ policy: readPolicy }));

    expect(result.statusCode).toBe(201);
    expect(body(result)).toStrictEqual({ etag: expect.any(String), created: true });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET)?.policy).toStrictEqual(readPolicy);
  });

  it('replaces the policy under the etag it read and answers 200', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);
    const next: BucketPolicy = {
      statement: [{ effect: 'deny', principal: '*', action: ['s3:DeleteObject'] }],
    };

    const result = await baseHandler(request({ policy: next, etag }));

    expect(result.statusCode).toBe(200);
    expect(body(result).created).toBe(false);
    expect(body(result).etag).not.toBe(etag);
  });

  it('refuses a stale etag with nothing written', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);

    const result = await baseHandler(request({ policy: readPolicy, etag: '"stale"' }));

    expect(result.statusCode).toBe(409);
    expect(body(result).code).toBe(ApiErrorCode.POLICY_CONFLICT);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET)?.policy).toStrictEqual(readPolicy);
  });

  it('refuses creating a first policy where one exists', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);

    const result = await baseHandler(request({ policy: readPolicy }));

    expect(result.statusCode).toBe(409);
    expect(body(result).code).toBe(ApiErrorCode.POLICY_CONFLICT);
  });

  it('lets only an Owner grant a retention write, before any vendor call', async () => {
    const admin = await baseHandler(request({ policy: retentionGrant }, { role: OrgRole.Admin }));
    expect(admin.statusCode).toBe(403);
    expect(body(admin).code).toBe(ApiErrorCode.RETENTION_GRANT_FORBIDDEN);
    expect(iam.calls).toHaveLength(0);
    expect(ensureTenantReady).not.toHaveBeenCalled();

    const owner = await baseHandler(request({ policy: retentionGrant }, { role: OrgRole.Owner }));
    expect(owner.statusCode).toBe(201);
  });

  it('lets an Admin edit around the roster statement\u2019s s3:* without granting it again', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET, {
      statement: [
        { sid: 'filone-owners', effect: 'allow', principal: [USER_ID], action: ['s3:*'] },
      ],
    });
    iam.seedPrincipal(TENANT_ID, 'friend');
    const edited: BucketPolicy = {
      statement: [
        { sid: 'filone-owners', effect: 'allow', principal: [USER_ID], action: ['s3:*'] },
        { effect: 'allow', principal: ['friend'], action: ['s3:GetObject'] },
      ],
    };

    const result = await baseHandler(request({ policy: edited, etag }, { role: OrgRole.Admin }));

    expect(result.statusCode).toBe(200);
  });

  it('refuses an Admin restoring the Owners roster statement, since s3:* is an Owner\u2019s to grant', async () => {
    const result = await baseHandler(
      request(
        {
          policy: {
            statement: [
              { sid: 'filone-owners', effect: 'allow', principal: [USER_ID], action: ['s3:*'] },
            ],
          },
        },
        { role: OrgRole.Admin },
      ),
    );

    expect([result.statusCode, body(result).code]).toStrictEqual([
      403,
      ApiErrorCode.RETENTION_GRANT_FORBIDDEN,
    ]);
  });

  it('refuses an Admin naming a retention write even for an Owner who holds s3:*', async () => {
    const owners: PolicyStatement = {
      sid: 'filone-owners',
      effect: 'allow',
      principal: [USER_ID],
      action: ['s3:*'],
    };
    const etag = iam.seedPolicy(TENANT_ID, BUCKET, { statement: [owners] });
    const named: BucketPolicy = {
      statement: [
        owners,
        { effect: 'allow', principal: [USER_ID], action: ['s3:PutObjectLegalHold'] },
      ],
    };

    const result = await baseHandler(request({ policy: named, etag }, { role: OrgRole.Admin }));

    expect([result.statusCode, body(result).code]).toStrictEqual([
      403,
      ApiErrorCode.RETENTION_GRANT_FORBIDDEN,
    ]);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET)?.etag).toBe(etag);
  });

  it('lets an Admin keep or narrow a retention write an Owner named', async () => {
    const hold: PolicyStatement = {
      sid: 'hold',
      effect: 'allow',
      principal: ['friend'],
      action: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
    };
    const statuses = [];
    for (const next of [hold, { ...hold, action: ['s3:PutObjectRetention'] } as PolicyStatement]) {
      resetFixture();
      iam.seedPrincipal(TENANT_ID, 'friend');
      const etag = iam.seedPolicy(TENANT_ID, BUCKET, { statement: [hold] });
      const result = await baseHandler(
        request({ policy: { statement: [next] }, etag }, { role: OrgRole.Admin }),
      );
      statuses.push(result.statusCode);
    }

    expect(statuses).toStrictEqual([200, 200]);
  });

  it('refuses an Admin widening a retention write to a new principal', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET, {
      statement: [
        { sid: 'filone-owners', effect: 'allow', principal: [USER_ID], action: ['s3:*'] },
      ],
    });
    iam.seedPrincipal(TENANT_ID, 'friend');
    const widened: BucketPolicy = {
      statement: [
        { sid: 'filone-owners', effect: 'allow', principal: [USER_ID], action: ['s3:*'] },
        { effect: 'allow', principal: ['friend'], action: ['s3:PutObjectRetention'] },
      ],
    };

    const result = await baseHandler(request({ policy: widened, etag }, { role: OrgRole.Admin }));

    expect(result.statusCode).toBe(403);
    expect(body(result).code).toBe(ApiErrorCode.RETENTION_GRANT_FORBIDDEN);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET)?.etag).toBe(etag);
  });

  it('refuses a document the schema does not accept as a 400', async () => {
    const result = await baseHandler(
      request({
        policy: { statement: [{ effect: 'allow', principal: ['*'], action: ['s3:GetObject'] }] },
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(iam.calls).toHaveLength(0);
  });

  it('answers as a bucket with no policy on a region that serves none', async () => {
    const result = await baseHandler(request({ policy: readPolicy }, { region: SCOPED_REGION }));

    expect(result.statusCode).toBe(404);
    expect(body(result).code).toBe(ApiErrorCode.POLICY_NOT_FOUND);
    expect(ensureTenantReady).not.toHaveBeenCalled();
  });

  it('410s without touching the vendor when the org is being deleted', async () => {
    isOrgDeleting.mockResolvedValueOnce(true);

    const result = await baseHandler(request({ policy: readPolicy }));

    expect(result.statusCode).toBe(410);
    expect(iam.calls).toHaveLength(0);
  });

  it('surfaces a principal the storage system does not know as a 400', async () => {
    const stranger: BucketPolicy = {
      statement: [{ effect: 'allow', principal: ['nobody'], action: ['s3:GetObject'] }],
    };
    const result = await baseHandler(request({ policy: stranger }));
    expect(result.statusCode).toBe(400);
  });

  it('answers 503 when the storage system could not publish the change', async () => {
    iam.failNext('putBucketPolicy', new PolicyPublishError());

    const result = await baseHandler(request({ policy: readPolicy }));

    expect(result.statusCode).toBe(503);
  });

  it('writes the intent before the vendor call and closes it with the document size', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);
    const next: BucketPolicy = {
      statement: [
        { effect: 'allow', principal: [USER_ID, 'friend'], action: ['s3:GetObject'] },
        { effect: 'deny', principal: '*', action: ['s3:DeleteObject'] },
      ],
    };
    iam.seedPrincipal(TENANT_ID, 'friend');

    await baseHandler(request({ policy: next, etag }));

    const [intent, completion] = auditEvents();
    expect(intent).toMatchObject({
      type: 'bucket_policy.updated',
      phase: 'intent',
      subject: `bucket:${IAM_REGION}/${BUCKET}`,
      details: { region: IAM_REGION, bucketName: BUCKET, trigger: 'policy_edit' },
    });
    expect(completion).toMatchObject({
      type: 'bucket_policy.updated',
      phase: 'completion',
      outcome: 'succeeded',
      details: { statements: 2, principals: 2 },
    });
    expect(completion!.correlationId).toBe(intent!.correlationId);
  });

  it('records a create as bucket_policy.created and a refused write as a failed completion', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET, readPolicy);

    await baseHandler(request({ policy: readPolicy }));

    const [intent, completion] = auditEvents();
    expect(intent).toMatchObject({ type: 'bucket_policy.created', phase: 'intent' });
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'failed' });
  });
});
