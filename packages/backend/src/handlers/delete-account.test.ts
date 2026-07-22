import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, OrgRole } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
  },
}));

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

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
process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME = 'account-deletion-worker';

import { baseHandler } from './delete-account.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const SUB = 'auth0|sub-1';

function makeEvent(body?: Record<string, unknown>) {
  const event = buildEvent({
    method: 'POST',
    userInfo: { sub: SUB, userId: USER_ID, orgId: ORG_ID, email: 'user@example.com' },
    body: JSON.stringify(body ?? { code: '123456', orgName: 'Acme Corp' }),
  });
  return event;
}

function setupHappyMocks() {
  ddbMock.reset();
  lambdaMock.reset();
  mockGetOrgProfile.mockResolvedValue({
    pk: { S: `ORG#${ORG_ID}` },
    sk: { S: 'PROFILE' },
    name: { S: 'Acme Corp' },
    auroraTenantId: { S: 'aurora-t-1' },
  });
  mockVerifyChallenge.mockResolvedValue('ok');
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `MEMBER#${USER_ID}` } } })
    .resolves({ Item: marshall({ role: OrgRole.Admin }) });
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `USER#${USER_ID}` }, sk: { S: 'PROFILE' } } })
    .resolves({ Item: marshall({ sub: SUB }) });
  ddbMock
    .on(GetItemCommand, { Key: { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } } })
    .resolves({ Item: marshall({ stripeCustomerId: 'cus_1', subscriptionId: 'sub_1' }) });
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

  it('happy path: writes the deletion record, fences, kills sessions, invokes the worker, clears cookies', async () => {
    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);

    // DELETION record snapshot with conditional create.
    const put = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(put.Item!.sk.S).toBe('DELETION');
    expect(put.Item!.status.S).toBe('PENDING');
    expect(put.Item!.auroraTenantId?.S).toBe('aurora-t-1');
    expect(put.Item!.subscriptionId?.S).toBe('sub_1');

    const updates = ddbMock.commandCalls(UpdateItemCommand).map((c) => c.args[0].input);
    // Profile deleting fence.
    expect(
      updates.some(
        (u) => u.Key?.sk?.S === 'PROFILE' && u.UpdateExpression === 'SET deleting = :true',
      ),
    ).toBe(true);
    // Billing webhook fence.
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
