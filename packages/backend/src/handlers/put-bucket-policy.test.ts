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

import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { BucketPolicy, PolicyStatement } from '@filone/shared';
import { PolicyPublishError } from '../lib/errors.ts';
import type { PolicyPrecondition } from '../lib/bucket-policy-orchestrator.ts';
import { baseHandler } from './put-bucket-policy.ts';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.ts';
import {
  BUCKET_NAME,
  IAM_REGION,
  ORG_ID,
  SERVICE_KEYS_REGION,
  TENANT_ID,
  USER_ID,
  ensureTenantReady,
  getAuditEvents,
  grantGetObjectToUser,
  iam,
  isOrgDeleting,
  orchestrator,
  resetFixture,
} from '../test/bucket-policy-fixture.ts';

function buildPutEvent(
  policy: BucketPolicy,
  {
    precondition = { ifNoneMatch: '*' },
    role = OrgRole.Owner,
    region = IAM_REGION,
  }: { precondition?: PolicyPrecondition | 'none'; role?: OrgRole; region?: string } = {},
) {
  const event = buildEvent({
    method: 'PUT',
    body: JSON.stringify({ policy }),
    userInfo: {
      userId: USER_ID,
      orgId: ORG_ID,
      email: 'owner@example.com',
      membership: membershipFor(ORG_ID, USER_ID, role),
    },
    queryStringParameters: { region },
  });
  event.headers =
    precondition === 'none'
      ? {}
      : precondition.ifMatch !== undefined
        ? { 'if-match': precondition.ifMatch }
        : { 'if-none-match': precondition.ifNoneMatch };
  event.pathParameters = { name: BUCKET_NAME };
  return event;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=2592000; includeSubDomains',
};

const parseResponseBody = (result: { body?: string }) => JSON.parse(result.body ?? '{}');

// A console user id, the only principal id the schema accepts.
const MEMBER_ID = '00000000-0000-4000-8000-00000000000a';
/** Never seeded, so the storage system does not know it. */
const UNKNOWN_PRINCIPAL_ID = '00000000-0000-4000-8000-00000000000c';

const grantRetentionToUser: BucketPolicy = {
  Statement: [{ Effect: 'Allow', Principal: [USER_ID], Action: ['s3:PutObjectRetention'] }],
};

const denyDeleteToEveryone: BucketPolicy = {
  Statement: [{ Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject'] }],
};

const grantAllToOwner: PolicyStatement = {
  Sid: 'owners',
  Effect: 'Allow',
  Principal: [USER_ID],
  Action: ['s3:*'],
};

describe('put-bucket-policy baseHandler', () => {
  beforeEach(resetFixture);

  it('creates the first policy under If-None-Match: * and answers 204 with the new ETag', async () => {
    const result = await baseHandler(buildPutEvent(grantGetObjectToUser));

    expect(result).toMatchObject({
      statusCode: 204,
      headers: {
        ...SECURITY_HEADERS,
        ETag: iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.etag,
      },
      body: '',
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.policy).toStrictEqual(
      grantGetObjectToUser,
    );
  });

  it('replaces the policy under the If-Match it read', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(
      buildPutEvent(denyDeleteToEveryone, { precondition: { ifMatch: etag } }),
    );

    expect(result.statusCode).toBe(204);
    expect(result.headers?.ETag).not.toBe(etag);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.policy).toStrictEqual(
      denyDeleteToEveryone,
    );
  });

  it('creates the policy when no precondition header is sent', async () => {
    const result = await baseHandler(buildPutEvent(grantGetObjectToUser, { precondition: 'none' }));

    expect(result.statusCode).toBe(204);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.policy).toStrictEqual(
      grantGetObjectToUser,
    );
  });

  it('replaces the policy when no precondition header is sent', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildPutEvent(denyDeleteToEveryone, { precondition: 'none' }));

    expect(result.statusCode).toBe(204);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.policy).toStrictEqual(
      denyDeleteToEveryone,
    );
  });

  it.each<[string, Record<string, string>, string]>([
    [
      'both headers are sent',
      { 'if-match': '"v1"', 'if-none-match': '*' },
      'Send If-Match or If-None-Match, not both',
    ],
    ['If-None-Match is not *', { 'if-none-match': '"v1"' }, 'If-None-Match must be *'],
    // Header values are trimmed, so a blank one reads as empty.
    ['If-Match is blank', { 'if-match': ' ' }, 'If-Match and If-None-Match cannot be empty'],
  ])('answers 400 without calling the storage system when %s', async (_when, headers, message) => {
    const event = buildPutEvent(grantGetObjectToUser, { precondition: 'none' });
    event.headers = headers;

    const result = await baseHandler(event);

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message },
    });
    expect(iam.calls).toHaveLength(0);
  });

  it('refuses an etag in the body, which belongs in If-Match', async () => {
    const event = buildPutEvent(grantGetObjectToUser);
    event.body = JSON.stringify({ policy: grantGetObjectToUser, etag: '"v1"' });

    const result = await baseHandler(event);

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message: 'Unrecognized key: "etag"' },
    });
  });

  it('refuses a stale If-Match with nothing written', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(
      buildPutEvent(grantGetObjectToUser, { precondition: { ifMatch: '"stale"' } }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 412,
      body: { code: ApiErrorCode.POLICY_CONFLICT },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.policy).toStrictEqual(
      grantGetObjectToUser,
    );
  });

  it('answers 412 to If-None-Match: * when a policy exists', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildPutEvent(denyDeleteToEveryone));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 412,
      body: { code: ApiErrorCode.POLICY_CONFLICT },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual({
      policy: grantGetObjectToUser,
      etag,
    });
  });

  it('refuses an Admin’s first policy that grants a retention write, before any vendor call', async () => {
    const result = await baseHandler(buildPutEvent(grantRetentionToUser, { role: OrgRole.Admin }));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.calls).toHaveLength(0);
    expect(ensureTenantReady).not.toHaveBeenCalled();
  });

  it('lets an Owner’s first policy grant a retention write', async () => {
    const result = await baseHandler(buildPutEvent(grantRetentionToUser, { role: OrgRole.Owner }));

    expect(result.statusCode).toBe(204);
  });

  it('lets an Admin add a statement beside the Owners’ s3:* statement', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, { Statement: [grantAllToOwner] });
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const edited: BucketPolicy = {
      Statement: [
        grantAllToOwner,
        { Effect: 'Allow', Principal: [MEMBER_ID], Action: ['s3:GetObject'] },
      ],
    };

    const result = await baseHandler(
      buildPutEvent(edited, { precondition: { ifMatch: etag }, role: OrgRole.Admin }),
    );

    expect(result.statusCode).toBe(204);
  });

  it('refuses an Admin’s first policy that grants s3:* to Owners', async () => {
    const result = await baseHandler(
      buildPutEvent({ Statement: [grantAllToOwner] }, { role: OrgRole.Admin }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
  });

  it('refuses an Admin naming a retention write even for an Owner who holds s3:*', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, { Statement: [grantAllToOwner] });
    const named: BucketPolicy = {
      Statement: [
        grantAllToOwner,
        { Effect: 'Allow', Principal: [USER_ID], Action: ['s3:PutObjectLegalHold'] },
      ],
    };

    const result = await baseHandler(
      buildPutEvent(named, { precondition: { ifMatch: etag }, role: OrgRole.Admin }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.etag).toBe(etag);
  });

  const ownerGrantedRetention: PolicyStatement = {
    Sid: 'hold',
    Effect: 'Allow',
    Principal: [MEMBER_ID],
    Action: ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
  };

  it.each<[string, PolicyStatement]>([
    ['keep', ownerGrantedRetention],
    ['narrow', { ...ownerGrantedRetention, Action: ['s3:PutObjectRetention'] }],
  ])('lets an Admin %s a retention write an Owner granted', async (_change, next) => {
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, { Statement: [ownerGrantedRetention] });

    const result = await baseHandler(
      buildPutEvent(
        { Statement: [next] },
        { precondition: { ifMatch: etag }, role: OrgRole.Admin },
      ),
    );

    expect(result.statusCode).toBe(204);
  });

  it('refuses an Admin dropping the deny that withheld a retention write', async () => {
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const allow: PolicyStatement = {
      Effect: 'Allow',
      Principal: [MEMBER_ID],
      Action: ['s3:PutObjectRetention'],
    };
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, {
      Statement: [allow, { ...allow, Effect: 'Deny' }],
    });

    const result = await baseHandler(
      buildPutEvent(
        { Statement: [allow] },
        { precondition: { ifMatch: etag }, role: OrgRole.Admin },
      ),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.etag).toBe(etag);
  });

  it('lets an Admin grant a member a retention write that an Allow to * already grants', async () => {
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const everyone: PolicyStatement = {
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:PutObjectRetention'],
    };
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, { Statement: [everyone] });
    const named: BucketPolicy = {
      Statement: [everyone, { ...everyone, Principal: [MEMBER_ID] }],
    };

    const result = await baseHandler(
      buildPutEvent(named, { precondition: { ifMatch: etag }, role: OrgRole.Admin }),
    );

    expect(result.statusCode).toBe(204);
  });

  it('refuses an Admin granting a retention write to a member who does not hold it', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, { Statement: [grantAllToOwner] });
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const widened: BucketPolicy = {
      Statement: [
        grantAllToOwner,
        { Effect: 'Allow', Principal: [MEMBER_ID], Action: ['s3:PutObjectRetention'] },
      ],
    };

    const result = await baseHandler(
      buildPutEvent(widened, { precondition: { ifMatch: etag }, role: OrgRole.Admin }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.etag).toBe(etag);
  });

  it('refuses an Admin’s unconditional write that adds a retention grant to the stored policy', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(
      buildPutEvent(grantRetentionToUser, { precondition: 'none', role: OrgRole.Admin }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)?.etag).toBe(etag);
  });

  it('answers 412 when the policy changes between the retention check and an Admin’s unconditional write', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);
    // The check reads a version that is no longer stored when the write lands.
    vi.spyOn(iam, 'getBucketPolicy').mockResolvedValueOnce({
      policy: grantGetObjectToUser,
      etag: '"old"',
    });

    const result = await baseHandler(
      buildPutEvent(grantGetObjectToUser, { precondition: 'none', role: OrgRole.Admin }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 412,
      body: { code: ApiErrorCode.POLICY_CONFLICT },
    });
  });

  it('refuses * inside a Principal list', async () => {
    const result = await baseHandler(
      buildPutEvent({
        // '*' is valid only as the bare Principal string, never as a list entry.
        Statement: [{ Effect: 'Allow', Principal: ['*'], Action: ['s3:GetObject'] }],
      }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message: 'Invalid input' },
    });
    expect(iam.calls).toHaveLength(0);
  });

  it('answers 501 in a region whose network does not serve the iam access model', async () => {
    const result = await baseHandler(
      buildPutEvent(grantGetObjectToUser, { region: SERVICE_KEYS_REGION }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 501,
      body: { message: 'Bucket policies are not available in this region' },
    });
    expect(ensureTenantReady).not.toHaveBeenCalled();
  });

  it('answers 503 without provisioning a tenant when the org has none in the region', async () => {
    orchestrator.isTenantReady.mockReturnValueOnce(null);

    const result = await baseHandler(buildPutEvent(grantGetObjectToUser));

    expect(result.statusCode).toBe(503);
    expect(iam.calls).toHaveLength(0);
    expect(ensureTenantReady).not.toHaveBeenCalled();
  });

  it('answers 410 without calling the storage system when the org is being deleted', async () => {
    isOrgDeleting.mockResolvedValueOnce(true);

    const result = await baseHandler(buildPutEvent(grantGetObjectToUser));

    expect(result.statusCode).toBe(410);
    expect(iam.calls).toHaveLength(0);
  });

  it('answers 400 when a statement names a member the region does not know', async () => {
    const result = await baseHandler(
      buildPutEvent({
        Statement: [
          { Effect: 'Allow', Principal: [UNKNOWN_PRINCIPAL_ID], Action: ['s3:GetObject'] },
        ],
      }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message: `unknown principal "${UNKNOWN_PRINCIPAL_ID}"` },
    });
  });

  it('answers 503 when the storage system could not publish the change', async () => {
    iam.failNext('putBucketPolicy', new PolicyPublishError());

    const result = await baseHandler(buildPutEvent(grantGetObjectToUser));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 503,
      body: {
        message: 'The storage system could not apply the policy change. Try again in a moment.',
      },
    });
  });

  it('records an updated intent and a succeeded completion with the statement and principal counts', async () => {
    const etag = iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const next: BucketPolicy = {
      Statement: [
        { Effect: 'Allow', Principal: [USER_ID, MEMBER_ID], Action: ['s3:GetObject'] },
        ...denyDeleteToEveryone.Statement,
      ],
    };

    await baseHandler(buildPutEvent(next, { precondition: { ifMatch: etag } }));

    const [intent, completion] = getAuditEvents();
    expect(intent).toMatchObject({
      type: 'bucket_policy.updated',
      phase: 'intent',
      subject: `bucket:${IAM_REGION}/${BUCKET_NAME}`,
      details: { region: IAM_REGION, bucketName: BUCKET_NAME, trigger: 'policy_edited' },
    });
    expect(completion).toMatchObject({
      type: 'bucket_policy.updated',
      phase: 'completion',
      outcome: 'succeeded',
      correlationId: intent!.correlationId,
      details: { statements: 2, principals: 2 },
    });
  });

  it('records a refused first-policy write as a created intent with a failed completion', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    await baseHandler(buildPutEvent(grantGetObjectToUser));

    const [intent, completion] = getAuditEvents();
    expect(intent).toMatchObject({ type: 'bucket_policy.created', phase: 'intent' });
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'failed' });
  });
});
