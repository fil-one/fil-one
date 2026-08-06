import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, OrgRole } from '@filone/shared';

// The handler imports the REAL orchestrator registry (via region-helpers) to
// snapshot tenant ids for every provisioned region — deliberately unmocked so
// adding a region to the registry exercises this suite. The FTH client is
// constructed at module load, so its env must exist before imports evaluate.
vi.hoisted(() => {
  process.env.FILONE_STAGE = 'test';
  process.env.FTH_MANAGEMENT_API_URL = 'https://fth.test.example.com';
  process.env.FORGE_MANAGEMENT_API_URL = 'https://forge.test.example.com';
});

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    FthManagementApiToken: { value: 'fth-token' },
    ForgeManagementApiToken: { value: 'forge-token' },
    AuroraBackofficeToken: { value: 'aurora-token' },
  },
}));

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

// Handler-level mocks: the full middy stack (auth, CSRF, MFA step-up gate)
// is exercised by the second describe below.
const { mockJwtVerify, mockGetMfaEnrollments } = vi.hoisted(() => ({
  mockJwtVerify: vi.fn(),
  mockGetMfaEnrollments: vi.fn(),
}));
vi.mock('jose', async () => (await import('../test/auth-mocks.js')).joseMockModule(mockJwtVerify));
vi.mock('../lib/auth0-management.js', async () =>
  (await import('../test/auth-mocks.js')).auth0ManagementMockModule(mockGetMfaEnrollments),
);

const mockVerifyChallenge = vi.fn();
vi.mock('../lib/deletion-challenge.js', () => ({
  verifyDeletionChallenge: (...args: unknown[]) => mockVerifyChallenge(...args),
}));

const mockGetOrgProfile = vi.fn();
vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: (orgId: string) => mockGetOrgProfile(orgId),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

const ddbMock = mockClient(DynamoDBClient);
const lambdaMock = mockClient(LambdaClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME = 'account-deletion-worker';

import { baseHandler, handler } from './delete-account.js';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import { OrgSetupStatus } from '../lib/org-setup-status.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
import { buildAuthenticatedEvent, setupAuthMocks } from '../test/auth-mocks.js';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const SUB = 'auth0|sub-1';

/**
 * Profile with a provisioned tenant for EVERY available orchestrator: each one
 * stores its tenant id under the `${id}TenantId` PROFILE attribute (aurora
 * additionally gates readiness on its setup status). Built programmatically so
 * a region added to the registry automatically joins this fixture.
 */
function fullyProvisionedProfile() {
  return {
    pk: { S: `ORG#${ORG_ID}` },
    sk: { S: 'PROFILE' },
    name: { S: 'Acme Corp' },
    auroraSetupStatus: { S: OrgSetupStatus.AURORA_S3_ACCESS_KEY_CREATED },
    ...Object.fromEntries(
      getAvailableOrchestrators().map((o) => [`${o.id}TenantId`, { S: `${o.id}-t-1` }]),
    ),
  };
}

function makeEvent(body?: Record<string, unknown>) {
  const event = buildEvent({
    method: 'POST',
    userInfo: { sub: SUB, userId: USER_ID, orgId: ORG_ID, email: 'user@example.com' },
    body: JSON.stringify(body ?? { code: '123456', orgName: 'Acme Corp' }),
  });
  return event;
}

/**
 * Rows the snapshots' BatchGetItem reads resolve against, keyed `table|pk`.
 * Absent keys are simply omitted from the response, as DynamoDB does.
 */
const batchGetRows = new Map<string, Record<string, unknown>>();

function putBatchGetRow(table: string, item: Record<string, unknown>) {
  batchGetRows.set(`${table}|${item.pk as string}`, item);
}

function stubBatchGet() {
  type RequestItems = Record<string, { Keys: Record<string, { S: string }>[] }>;
  ddbMock.on(BatchGetItemCommand).callsFake((input: { RequestItems: RequestItems }) => ({
    Responses: Object.fromEntries(
      Object.entries(input.RequestItems).map(([table, { Keys }]) => [
        table,
        Keys.map((key) => batchGetRows.get(`${table}|${key.pk.S}`))
          .filter((row) => row !== undefined)
          .map((row) => marshall(row)),
      ]),
    ),
  }));
}

function setupHappyMocks() {
  ddbMock.reset();
  lambdaMock.reset();
  batchGetRows.clear();
  mockGetOrgProfile.mockResolvedValue(fullyProvisionedProfile());
  mockVerifyChallenge.mockResolvedValue('ok');
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `MEMBER#${USER_ID}` } } })
    .resolves({ Item: marshall({ role: OrgRole.Admin }) });
  putBatchGetRow('UserInfoTable', { pk: `USER#${USER_ID}`, sk: 'PROFILE', sub: SUB });
  putBatchGetRow('BillingTable', {
    pk: `CUSTOMER#${USER_ID}`,
    sk: 'SUBSCRIPTION',
    stripeCustomerId: 'cus_1',
    subscriptionId: 'sub_1',
  });
  stubBatchGet();
  ddbMock.on(QueryCommand).resolves({
    Items: [marshall({ pk: `ORG#${ORG_ID}`, sk: `MEMBER#${USER_ID}` })],
  });
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(UpdateItemCommand).resolves({});
  lambdaMock.on(InvokeCommand).resolves({});
}

describe('delete-account baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyMocks();
  });

  it('rejects an org-name mismatch with 400 and writes nothing', async () => {
    const result = (await baseHandler(
      makeEvent({ code: '123456', orgName: 'Wrong Name' }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(mockVerifyChallenge).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('rejects a non-admin member with 403', async () => {
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `MEMBER#${USER_ID}` } } })
      .resolves({ Item: marshall({ role: 'member' }) });

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(403);
    expect(mockVerifyChallenge).not.toHaveBeenCalled();
  });

  it('rejects an invalid code with 400 DELETION_CODE_INVALID and writes no state', async () => {
    mockVerifyChallenge.mockResolvedValue('invalid');

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.DELETION_CODE_INVALID);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('rejects an expired/locked code with 410', async () => {
    mockVerifyChallenge.mockResolvedValue('expired_or_locked');

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(410);
    expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED);
  });

  it('happy path: writes the deletion record, applies the deletion guards, kills sessions, invokes the worker, clears cookies', async () => {
    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);

    // DELETION record snapshot with conditional create.
    const put = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(put.Item!.sk.S).toBe('DELETION');
    expect(put.Item!.status.S).toBe('PENDING');
    expect(unmarshall(put.Item!).billingCustomers).toEqual([
      { stripeCustomerId: 'cus_1', subscriptionId: 'sub_1' },
    ]);

    // Region-generic tenant snapshot: EVERY orchestrator provisioned for the
    // org must appear in the written tenantIds map, keyed by orchestrator id —
    // a region added to the registry that deletion misses fails this test.
    const orchestrators = getAvailableOrchestrators();
    expect(orchestrators.length).toBeGreaterThan(0);
    const written = unmarshall(put.Item!) as { tenantIds: Record<string, string> };
    for (const orchestrator of orchestrators) {
      expect(written.tenantIds[orchestrator.id]).toBe(`${orchestrator.id}-t-1`);
    }
    expect(Object.keys(written.tenantIds)).toHaveLength(orchestrators.length);
    // The legacy per-orchestrator fields are no longer written.
    expect(put.Item!.auroraTenantId).toBeUndefined();
    expect(put.Item!.fthTenantId).toBeUndefined();

    const updates = ddbMock.commandCalls(UpdateItemCommand).map((c) => c.args[0].input);
    // Profile deleting guard.
    expect(
      updates.some(
        (u) => u.Key?.sk?.S === 'PROFILE' && u.UpdateExpression === 'SET deleting = :true',
      ),
    ).toBe(true);
    // Billing webhook deletion guard.
    expect(
      updates.some(
        (u) =>
          u.Key?.pk?.S === `CUSTOMER#${USER_ID}` &&
          u.UpdateExpression === 'SET deletionRequestedAt = :now',
      ),
    ).toBe(true);
    // Session kill on the SUB# identity row.
    expect(
      updates.some(
        (u) => u.Key?.pk?.S === `SUB#${SUB}` && u.UpdateExpression?.includes('deleted = :true'),
      ),
    ).toBe(true);

    // Worker invoked async.
    const invoke = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
    expect(invoke.FunctionName).toBe('account-deletion-worker');
    expect(invoke.InvocationType).toBe('Event');
    expect(JSON.parse(new TextDecoder().decode(invoke.Payload as Uint8Array))).toEqual({
      orgId: ORG_ID,
    });

    // Cookies cleared in the success response.
    expect(result.cookies).toEqual(
      expect.arrayContaining([expect.stringContaining('hs_access_token=;')]),
    );
  });

  it('snapshots a half-provisioned tenant: tenantId present but setup incomplete', async () => {
    // Deleting mid-setup: the aurora tenant id exists on the profile but the
    // setup status never reached completion. isTenantReady would hide it —
    // the snapshot must still capture it or the remote tenant and its SSM
    // secrets leak forever once the profile row is purged.
    mockGetOrgProfile.mockResolvedValue({
      ...fullyProvisionedProfile(),
      auroraSetupStatus: { S: OrgSetupStatus.AURORA_TENANT_CREATED },
    });

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const put = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
    const written = unmarshall(put.Item!) as { tenantIds: Record<string, string> };
    expect(written.tenantIds.aurora).toBe('aurora-t-1');
  });

  it('paginates the MEMBER# query so a truncated page cannot silently drop members from the snapshot', async () => {
    // Two pages: user-1, then (via LastEvaluatedKey) user-2. A 1MB-truncated
    // single query would have missed user-2 — leaving their Auth0 user alive.
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [marshall({ pk: `ORG#${ORG_ID}`, sk: `MEMBER#${USER_ID}` })],
        LastEvaluatedKey: marshall({ pk: `ORG#${ORG_ID}`, sk: `MEMBER#${USER_ID}` }),
      })
      .resolves({ Items: [marshall({ pk: `ORG#${ORG_ID}`, sk: 'MEMBER#user-2' })] });
    putBatchGetRow('UserInfoTable', { pk: 'USER#user-2', sk: 'PROFILE', sub: 'auth0|sub-2' });

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);

    // Both pages' members are snapshotted with their subs.
    const put = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
    const written = unmarshall(put.Item!) as {
      members: { userId: string; sub?: string }[];
    };
    expect(written.members).toEqual([
      { userId: USER_ID, sub: SUB },
      { userId: 'user-2', sub: 'auth0|sub-2' },
    ]);

    // And both members' sessions are killed.
    const updates = ddbMock.commandCalls(UpdateItemCommand).map((c) => c.args[0].input);
    for (const sub of [SUB, 'auth0|sub-2']) {
      expect(
        updates.some(
          (u) => u.Key?.pk?.S === `SUB#${sub}` && u.UpdateExpression?.includes('deleted = :true'),
        ),
      ).toBe(true);
    }
  });

  it('snapshots EVERY member billing customer when the one-customer-per-org invariant is violated', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        marshall({ pk: `ORG#${ORG_ID}`, sk: `MEMBER#${USER_ID}` }),
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'MEMBER#user-2' }),
      ],
    });
    putBatchGetRow('UserInfoTable', { pk: 'USER#user-2', sk: 'PROFILE', sub: 'auth0|sub-2' });
    putBatchGetRow('BillingTable', {
      pk: 'CUSTOMER#user-2',
      sk: 'SUBSCRIPTION',
      stripeCustomerId: 'cus_2',
      subscriptionId: 'sub_2',
    });

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const put = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
    const written = unmarshall(put.Item!) as {
      billingCustomers?: { stripeCustomerId?: string; subscriptionId?: string }[];
    };
    // Every member's Stripe pointers are captured, in members order, so
    // teardown can cancel and redact each of them.
    expect(written.billingCustomers).toEqual([
      { stripeCustomerId: 'cus_1', subscriptionId: 'sub_1' },
      { stripeCustomerId: 'cus_2', subscriptionId: 'sub_2' },
    ]);
  });

  it('degrades gracefully on a re-confirm after teardown purged the org profile (400 name mismatch)', async () => {
    // Once the async teardown deletes ORG#/PROFILE, a late re-confirm cannot
    // match the typed org name against anything — it falls into the
    // name-mismatch 400 rather than crashing or writing new state.
    mockGetOrgProfile.mockResolvedValue(undefined);

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toBe('Organization name does not match');
    expect(mockVerifyChallenge).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('is idempotent: a re-confirm after the record exists still invokes the worker', async () => {
    ddbMock
      .on(PutItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
  });

  it('org-name comparison trims whitespace but requires an exact match', async () => {
    const result = (await baseHandler(
      makeEvent({ code: '123456', orgName: '  Acme Corp  ' }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Full middy stack — the MFA step-up gate sits on the route, so these tests
// go through `handler` (auth + CSRF + requireMfaIfEnrolled), not baseHandler.
// ---------------------------------------------------------------------------

describe('delete-account handler (MFA step-up gate)', () => {
  function makeHandlerEvent() {
    return buildAuthenticatedEvent({
      method: 'POST',
      rawPath: '/api/account/delete',
      body: JSON.stringify({ code: '123456', orgName: 'Acme Corp' }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyMocks();
    // Password-only session: no 'mfa'/'phr' in amr, so the gate consults Auth0.
    setupAuthMocks({
      ddbMock,
      mockJwtVerify,
      sub: SUB,
      userId: USER_ID,
      orgId: ORG_ID,
      idTokenPayload: { amr: ['pwd'] },
    });
  });

  it('returns 401 step_up_required for an MFA-enrolled user without a strong-auth session', async () => {
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'e-1', type: 'authenticator', status: 'confirmed' },
    ]);

    const result = (await handler(
      makeHandlerEvent(),
      buildContext(),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body!)).toEqual({ error: 'step_up_required' });
    // The gate rejects BEFORE any deletion work.
    expect(mockVerifyChallenge).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('passes the gate for an un-enrolled user — the email code is their sole second factor', async () => {
    mockGetMfaEnrollments.mockResolvedValue([]);

    const result = (await handler(
      makeHandlerEvent(),
      buildContext(),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(mockGetMfaEnrollments).toHaveBeenCalledWith(SUB);
    expect(mockVerifyChallenge).toHaveBeenCalledWith(ORG_ID, '123456');
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
  });
});
