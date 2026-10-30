import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock());
vi.mock('../lib/service-orchestrator-registry.ts', async () => {
  const fixture = await import('../test/bucket-policy-fixture.ts');
  return { getOrchestratorForRegion: fixture.getOrchestratorForRegion };
});
const mockListMembers = vi.fn(async (): Promise<Array<{ userId: string }>> => []);
vi.mock('../lib/org-membership.ts', () => ({ listMembers: () => mockListMembers() }));
vi.mock('../lib/org-profile.ts', async () => {
  const fixture = await import('../test/bucket-policy-fixture.ts');
  return {
    getOrgProfile: async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } }),
    isOrgDeleting: fixture.isOrgDeleting,
  };
});

import { ApiErrorCode, OrgRole, toPolicyPrincipal } from '@filone/shared';
import type { BucketPolicy, PolicyStatement } from '@filone/shared';
import { PolicyPublishError } from '../lib/errors.ts';
import { baseHandler } from './put-bucket-policy.ts';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.ts';
import { policyOf, statement } from '../test/policy-statements.ts';
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
  { role = OrgRole.Owner, region = IAM_REGION }: { role?: OrgRole; region?: string } = {},
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
  event.headers = {};
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

const allow = (principal: '*' | string[], actions: PolicyStatement['Action'], sid?: string) => ({
  ...(sid ? { Sid: sid } : {}),
  ...statement(BUCKET_NAME, 'Allow', principal, actions),
});
const deny = (principal: '*' | string[], actions: PolicyStatement['Action'], sid?: string) => ({
  ...(sid ? { Sid: sid } : {}),
  ...statement(BUCKET_NAME, 'Deny', principal, actions),
});

const grantRetentionToUser = policyOf(allow([USER_ID], ['s3:PutObjectRetention']));

const denyDeleteToEveryone = policyOf(deny('*', ['s3:DeleteObject']));

const grantAllToOwner = allow([USER_ID], ['s3:*'], 'owners');

describe('put-bucket-policy baseHandler', () => {
  beforeEach(resetFixture);

  it('creates the first policy and answers 204 with no ETag header', async () => {
    const result = await baseHandler(buildPutEvent(grantGetObjectToUser));

    expect(result).toMatchObject({ statusCode: 204, headers: SECURITY_HEADERS, body: '' });
    expect(result.headers).not.toHaveProperty('ETag');
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual(grantGetObjectToUser);
  });

  it('replaces the stored policy', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildPutEvent(denyDeleteToEveryone));

    expect(result.statusCode).toBe(204);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual(denyDeleteToEveryone);
  });

  it('replaces the stored policy whatever If-Match the request carries, as on S3', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);
    const event = buildPutEvent(denyDeleteToEveryone);
    event.headers = { 'if-match': '"any-etag"' };

    const result = await baseHandler(event);

    expect(result.statusCode).toBe(204);
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual(denyDeleteToEveryone);
  });

  it('refuses an etag in the body', async () => {
    const event = buildPutEvent(grantGetObjectToUser);
    event.body = JSON.stringify({ policy: grantGetObjectToUser, etag: '"v1"' });

    const result = await baseHandler(event);

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message: 'Unrecognized key: "etag"' },
    });
  });

  it('refuses an Admin’s first policy that grants a retention write, with nothing written', async () => {
    const result = await baseHandler(buildPutEvent(grantRetentionToUser, { role: OrgRole.Admin }));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.has(BUCKET_NAME)).toBe(false);
  });

  it('lets an Owner’s first policy grant a retention write', async () => {
    const result = await baseHandler(buildPutEvent(grantRetentionToUser, { role: OrgRole.Owner }));

    expect(result.statusCode).toBe(204);
  });

  it('registers the current members a document names before writing it', async () => {
    mockListMembers.mockResolvedValue([{ userId: USER_ID }, { userId: MEMBER_ID }]);
    // MEMBER_ID is a member the storage system has not met.
    const policy = policyOf(
      grantGetObjectToUser.Statement[0]!,
      allow([MEMBER_ID], ['s3:GetObject']),
    );

    const result = await baseHandler(buildPutEvent(policy));

    expect(result.statusCode).toBe(204);
    expect(
      iam.calls.filter((call) => call.method === 'syncMember').map((call) => call.target),
    ).toStrictEqual([USER_ID, MEMBER_ID]);
  });

  it('registers nobody for a removed member a document still names', async () => {
    mockListMembers.mockResolvedValue([{ userId: USER_ID }]);
    const policy = policyOf(allow([MEMBER_ID], ['s3:GetObject']));

    const result = await baseHandler(buildPutEvent(policy));

    expect(result.statusCode).toBe(400);
    expect(
      iam.calls.some((call) => call.method === 'syncMember' && call.target === MEMBER_ID),
    ).toBe(false);
  });

  it('registers nobody for a document naming everyone', async () => {
    mockListMembers.mockResolvedValue([{ userId: USER_ID }]);
    const policy = policyOf(allow('*', ['s3:GetObject']));

    const result = await baseHandler(buildPutEvent(policy));

    expect(result.statusCode).toBe(204);
    expect(iam.calls.some((call) => call.method === 'syncMember')).toBe(false);
  });

  it('lets an Admin add a statement beside the Owners’ s3:* statement', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, policyOf(grantAllToOwner));
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const edited = policyOf(grantAllToOwner, allow([MEMBER_ID], ['s3:GetObject']));

    const result = await baseHandler(buildPutEvent(edited, { role: OrgRole.Admin }));

    expect(result.statusCode).toBe(204);
  });

  it('refuses an Admin’s first policy that grants s3:* to Owners', async () => {
    const result = await baseHandler(
      buildPutEvent(policyOf(grantAllToOwner), { role: OrgRole.Admin }),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
  });

  it('refuses an Admin naming a retention write even for an Owner who holds s3:*', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, policyOf(grantAllToOwner));
    const named = policyOf(grantAllToOwner, allow([USER_ID], ['s3:PutObjectLegalHold']));

    const result = await baseHandler(buildPutEvent(named, { role: OrgRole.Admin }));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual(policyOf(grantAllToOwner));
  });

  const ownerGrantedRetention = allow(
    [MEMBER_ID],
    ['s3:PutObjectRetention', 's3:PutObjectLegalHold'],
    'hold',
  );

  it.each<[string, PolicyStatement]>([
    ['keep', ownerGrantedRetention],
    ['narrow', { ...ownerGrantedRetention, Action: ['s3:PutObjectRetention'] }],
  ])('lets an Admin %s a retention write an Owner granted', async (_change, next) => {
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, policyOf(ownerGrantedRetention));

    const result = await baseHandler(buildPutEvent(policyOf(next), { role: OrgRole.Admin }));

    expect(result.statusCode).toBe(204);
  });

  it('refuses an Admin dropping the deny that withheld a retention write', async () => {
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const grant = allow([MEMBER_ID], ['s3:PutObjectRetention']);
    const stored = policyOf(grant, { ...grant, Effect: 'Deny' });
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, stored);

    const result = await baseHandler(buildPutEvent(policyOf(grant), { role: OrgRole.Admin }));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual(stored);
  });

  it('lets an Admin grant a member a retention write that an Allow to * already grants', async () => {
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const everyone = allow('*', ['s3:PutObjectRetention']);
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, policyOf(everyone));
    const named = policyOf(everyone, { ...everyone, Principal: toPolicyPrincipal([MEMBER_ID]) });

    const result = await baseHandler(buildPutEvent(named, { role: OrgRole.Admin }));

    expect(result.statusCode).toBe(204);
  });

  it('refuses an Admin granting a retention write to a member who does not hold it', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, policyOf(grantAllToOwner));
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const widened = policyOf(grantAllToOwner, allow([MEMBER_ID], ['s3:PutObjectRetention']));

    const result = await baseHandler(buildPutEvent(widened, { role: OrgRole.Admin }));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual(policyOf(grantAllToOwner));
  });

  it('refuses an Admin’s write that adds a retention grant to the stored policy', async () => {
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);

    const result = await baseHandler(buildPutEvent(grantRetentionToUser, { role: OrgRole.Admin }));

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 403,
      body: { code: ApiErrorCode.RETENTION_GRANT_FORBIDDEN },
    });
    expect(iam.policies.get(TENANT_ID)?.get(BUCKET_NAME)).toStrictEqual(grantGetObjectToUser);
  });

  it('refuses * inside a Principal list', async () => {
    const result = await baseHandler(
      buildPutEvent(
        // '*' is valid only as the bare Principal string, never as a list entry.
        policyOf({ ...allow('*', ['s3:GetObject']), Principal: { AWS: ['*'] } }),
      ),
    );

    expect({ ...result, body: parseResponseBody(result) }).toMatchObject({
      statusCode: 400,
      body: { message: expect.stringContaining('"*" names everyone as the bare string') },
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
      buildPutEvent(policyOf(allow([UNKNOWN_PRINCIPAL_ID], ['s3:GetObject']))),
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
    iam.seedPolicy(TENANT_ID, BUCKET_NAME, grantGetObjectToUser);
    iam.seedPrincipal(TENANT_ID, MEMBER_ID);
    const next = policyOf(
      allow([USER_ID, MEMBER_ID], ['s3:GetObject']),
      ...denyDeleteToEveryone.Statement,
    );

    await baseHandler(buildPutEvent(next, {}));

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

  it('records a refused first policy as an updated intent with a failed completion', async () => {
    await baseHandler(buildPutEvent(policyOf(allow([UNKNOWN_PRINCIPAL_ID], ['s3:GetObject']))));

    const [intent, completion] = getAuditEvents();
    expect(intent).toMatchObject({ type: 'bucket_policy.updated', phase: 'intent' });
    expect(completion).toMatchObject({ phase: 'completion', outcome: 'failed' });
  });
});
