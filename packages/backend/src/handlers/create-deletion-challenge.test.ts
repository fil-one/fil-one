import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
  },
}));

// Handler-level mocks: the full middy stack (auth, CSRF, MFA step-up gate)
// is exercised by the second describe below.
const { mockJwtVerify, mockGetMfaEnrollments } = vi.hoisted(() => ({
  mockJwtVerify: vi.fn(),
  mockGetMfaEnrollments: vi.fn(),
}));
vi.mock('jose', async () => (await import('../test/auth-mocks.js')).joseMockModule(mockJwtVerify));
vi.mock('../lib/auth-secrets.js', async () =>
  (await import('../test/auth-mocks.js')).authSecretsMockModule(),
);
vi.mock('../lib/auth0-management.js', async () =>
  (await import('../test/auth-mocks.js')).auth0ManagementMockModule(mockGetMfaEnrollments),
);

const mockReadDeletionRecord = vi.fn();
const mockClaimDeletionRedrive = vi.fn();
vi.mock('../lib/deletion-record.js', () => ({
  readDeletionRecord: (orgId: string) => mockReadDeletionRecord(orgId),
  claimDeletionRerun: (orgId: string) => mockClaimDeletionRedrive(orgId),
}));

const mockCreateChallenge = vi.fn();
vi.mock('../lib/deletion-challenge.js', () => ({
  createDeletionChallenge: (orgId: string, userId: string) => mockCreateChallenge(orgId, userId),
}));

const mockSendEmail = vi.fn();
vi.mock('../lib/deletion-email.js', () => ({
  sendDeletionCodeEmail: (params: unknown) => mockSendEmail(params),
}));

const mockGetOrgProfile = vi.fn();
vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: (orgId: string) => mockGetOrgProfile(orgId),
}));

const mockIsOrgAdmin = vi.fn();
vi.mock('../lib/org-membership.js', () => ({
  isOrgAdmin: (orgId: string, userId: string) => mockIsOrgAdmin(orgId, userId),
}));

const ddbMock = mockClient(DynamoDBClient);
const lambdaMock = mockClient(LambdaClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME = 'account-deletion-worker';

import { baseHandler, handler } from './create-deletion-challenge.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
import { buildAuthenticatedEvent, setupAuthMocks } from '../test/auth-mocks.js';

const ORG_ID = 'org-1';
const SUB = 'auth0|sub-1';

function makeEvent(opts?: { withEmail: boolean }) {
  const withEmail = opts?.withEmail ?? true;
  return buildEvent({
    method: 'POST',
    userInfo: {
      sub: 'auth0|sub-1',
      userId: 'user-1',
      orgId: ORG_ID,
      ...(withEmail ? { email: 'user@example.com' } : {}),
    },
  });
}

describe('create-deletion-challenge baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lambdaMock.reset();
    lambdaMock.on(InvokeCommand).resolves({});
    mockIsOrgAdmin.mockResolvedValue(true);
    mockReadDeletionRecord.mockResolvedValue(undefined);
    mockClaimDeletionRedrive.mockResolvedValue(true);
    mockGetOrgProfile.mockResolvedValue({ name: { S: 'Acme Corp' } });
    mockCreateChallenge.mockResolvedValue({
      outcome: 'created',
      code: '123456',
      expiresAt: '2026-07-10T00:15:00.000Z',
      resendAvailableAt: '2026-07-10T00:01:00.000Z',
    });
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('returns 400 when the authenticated session carries no email', async () => {
    const result = (await baseHandler(
      makeEvent({ withEmail: false }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toBe('No email on the authenticated session');
    expect(mockIsOrgAdmin).not.toHaveBeenCalled();
    expect(mockCreateChallenge).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects a non-admin member with 403 before doing any challenge work', async () => {
    mockIsOrgAdmin.mockResolvedValue(false);

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(403);
    expect(mockIsOrgAdmin).toHaveBeenCalledWith(ORG_ID, 'user-1');
    expect(mockCreateChallenge).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns 200 deletion_in_progress without issuing a code, and re-drives the teardown', async () => {
    // No new code is issued once a deletion exists. Re-invoking the idempotent
    // worker here is what makes a deletion that was never SCHEDULED (a failed
    // invoke, or a crash between consuming the code and invoking) recoverable
    // by a user retry — the only window this route can still be reached in,
    // since a fenced org's sessions are all answered 410.
    mockReadDeletionRecord.mockResolvedValue({ status: 'PENDING' });

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ outcome: 'deletion_in_progress' });
    expect(mockCreateChallenge).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();

    const invokes = lambdaMock.commandCalls(InvokeCommand);
    expect(invokes).toHaveLength(1);
    const invoke = invokes[0].args[0].input;
    expect(invoke.FunctionName).toBe('account-deletion-worker');
    expect(invoke.InvocationType).toBe('Event');
    expect(JSON.parse(new TextDecoder().decode(invoke.Payload as Uint8Array))).toEqual({
      orgId: ORG_ID,
    });
  });

  it('still reports deletion_in_progress when the re-invoke fails, rather than a generic 500', async () => {
    // `deletion_in_progress` is typed as a SUCCESS outcome and the endpoint is
    // documented as idempotent. A 500 here makes the website render its generic
    // server-error string — telling a user whose account is being deleted that
    // something unrelated went wrong. The failure is logged instead.
    mockReadDeletionRecord.mockResolvedValue({ status: 'PENDING' });
    lambdaMock.on(InvokeCommand).rejects(new Error('lambda is down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ outcome: 'deletion_in_progress' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('throttles the re-invoke: a click inside the cooldown schedules nothing', async () => {
    // Each invoke spawns a 900s / 1024MB worker, and this branch short-circuits
    // ahead of the code endpoint's own 5/hr limiter, so it needs a cooldown of
    // its own or a held-down button fans out workers.
    mockReadDeletionRecord.mockResolvedValue({ status: 'PENDING' });
    mockClaimDeletionRedrive.mockResolvedValue(false);

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ outcome: 'deletion_in_progress' });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('does not invoke the worker when no deletion has been confirmed yet', async () => {
    await baseHandler(makeEvent());

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(mockClaimDeletionRedrive).not.toHaveBeenCalled();
  });

  it('returns 429 with resendAvailableAt when rate limited, without sending email', async () => {
    mockCreateChallenge.mockResolvedValue({
      outcome: 'rate_limited',
      resendAvailableAt: '2026-07-10T00:01:00.000Z',
    });

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(429);
    const body = JSON.parse(result.body!);
    expect(body.code).toBe(ApiErrorCode.DELETION_RATE_LIMITED);
    expect(body.resendAvailableAt).toBe('2026-07-10T00:01:00.000Z');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('emails the code to the session address and returns the challenge timestamps', async () => {
    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledWith({
      to: 'user@example.com',
      orgName: 'Acme Corp',
      code: '123456',
    });
    expect(JSON.parse(result.body!)).toEqual({
      outcome: 'challenge_created',
      expiresAt: '2026-07-10T00:15:00.000Z',
      resendAvailableAt: '2026-07-10T00:01:00.000Z',
    });
  });

  it('propagates a SendGrid failure instead of silently succeeding', async () => {
    mockSendEmail.mockRejectedValue(new Error('SendGrid send failed (500)'));

    await expect(baseHandler(makeEvent())).rejects.toThrow('SendGrid send failed');
  });
});

// ---------------------------------------------------------------------------
// Full middy stack — the MFA step-up gate sits on the route, so these tests
// go through `handler` (auth + CSRF + requireMfaIfEnrolled), not baseHandler.
// ---------------------------------------------------------------------------

describe('create-deletion-challenge handler (MFA step-up gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockIsOrgAdmin.mockResolvedValue(true);
    mockReadDeletionRecord.mockResolvedValue(undefined);
    mockGetOrgProfile.mockResolvedValue({ name: { S: 'Acme Corp' } });
    mockCreateChallenge.mockResolvedValue({
      outcome: 'created',
      code: '123456',
      expiresAt: '2026-07-10T00:15:00.000Z',
      resendAvailableAt: '2026-07-10T00:01:00.000Z',
    });
    mockSendEmail.mockResolvedValue(undefined);
    // Password-only session: no 'mfa'/'phr' in amr, so the gate consults Auth0.
    setupAuthMocks({
      ddbMock,
      mockJwtVerify,
      sub: SUB,
      userId: 'user-1',
      orgId: ORG_ID,
      idTokenPayload: { amr: ['pwd'] },
    });
  });

  it('returns 401 step_up_required for an MFA-enrolled user without a strong-auth session', async () => {
    mockGetMfaEnrollments.mockResolvedValue([
      { id: 'e-1', type: 'authenticator', status: 'confirmed' },
    ]);

    const result = (await handler(
      buildAuthenticatedEvent({ rawPath: '/api/account/delete-challenge' }),
      buildContext(),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body!)).toEqual({ error: 'step_up_required' });
    // The gate rejects BEFORE any challenge work.
    expect(mockCreateChallenge).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('passes the gate for an un-enrolled user — the email code is their sole second factor', async () => {
    mockGetMfaEnrollments.mockResolvedValue([]);

    const result = (await handler(
      buildAuthenticatedEvent({ rawPath: '/api/account/delete-challenge' }),
      buildContext(),
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(mockGetMfaEnrollments).toHaveBeenCalledWith(SUB);
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });
});
