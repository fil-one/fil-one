import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AwsClientStub } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { vi, type Mock } from 'vitest';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';
import { buildEvent } from './lambda-test-utilities.js';

/**
 * Shared scaffolding for HANDLER-level tests that exercise the full middy
 * stack (httpHeaderNormalizer → authMiddleware → csrfMiddleware → step-up
 * gates → errorHandler) instead of calling `baseHandler` directly.
 *
 * The `vi.mock(...)` calls themselves MUST stay in each test file (vitest
 * hoists them), but their module shapes are shared here — use the async
 * factory form so the helper import is resolved before the factory runs:
 *
 *   const mockJwtVerify = vi.fn();
 *   vi.mock('jose', async () =>
 *     (await import('../test/auth-mocks.js')).joseMockModule(mockJwtVerify));
 */

export const TEST_CSRF_TOKEN = 'csrf-token-value';

/** Module factory for `vi.mock('jose', ...)`. */
export function joseMockModule(mockJwtVerify: Mock) {
  return {
    jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
    decodeJwt: vi.fn(),
    createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
  };
}

/** Module factory for `vi.mock('../lib/auth-secrets.js', ...)`. */
export function authSecretsMockModule() {
  return {
    getAuthSecrets: () => ({
      AUTH0_CLIENT_ID: 'test-client-id',
      AUTH0_CLIENT_SECRET: 'test-client-secret',
    }),
  };
}

/**
 * Module factory for `vi.mock('../lib/auth0-management.js', ...)` covering
 * what the step-up middlewares import: `getMfaEnrollments` plus the REAL
 * `MFA_GUARDIAN_TYPES` Set (the gate calls `.has` on it) pulled from the
 * actual module so the mock can never drift from it. Pass `extras` for any
 * further exports the handler under test consumes.
 */
export async function auth0ManagementMockModule(
  mockGetMfaEnrollments: Mock,
  extras: Record<string, unknown> = {},
) {
  const { MFA_GUARDIAN_TYPES } = await vi.importActual<typeof import('../lib/auth0-management.js')>(
    '../lib/auth0-management.js',
  );
  return {
    MFA_GUARDIAN_TYPES,
    getMfaEnrollments: (...args: unknown[]) => mockGetMfaEnrollments(...args),
    ...extras,
  };
}

/**
 * Request event as the full middy stack sees it: auth cookies plus the
 * matching CSRF cookie/header pair. No `userInfo` is pre-injected —
 * authMiddleware resolves it from the mocked identity row.
 */
export function buildAuthenticatedEvent(params?: {
  method?: string;
  rawPath?: string;
  body?: string;
}): APIGatewayProxyEventV2 & AuthenticatedEvent {
  const event = buildEvent({
    cookies: [
      'hs_access_token=valid-token',
      'hs_id_token=id-token',
      `hs_csrf_token=${TEST_CSRF_TOKEN}`,
    ],
    ...(params?.body !== undefined ? { body: params.body } : {}),
    method: params?.method ?? 'POST',
    rawPath: params?.rawPath ?? '/test',
  });
  event.headers['x-csrf-token'] = TEST_CSRF_TOKEN;
  // userInfo is populated by authMiddleware at runtime — the cast reflects
  // the shape the middy stack's handler type expects.
  return event as unknown as APIGatewayProxyEventV2 & AuthenticatedEvent;
}

/**
 * authMiddleware's two jwtVerify resolutions (access token, then ID token)
 * and the SUB#/IDENTITY + ORG#/PROFILE reads it performs. `idTokenPayload`
 * drives the OIDC claims the step-up gates read (e.g. `{ amr: ['pwd'] }`).
 * Requires `process.env.AUTH0_DOMAIN`/`AUTH0_AUDIENCE` to be set by the test
 * file before the handler module is imported.
 */
export function setupAuthMocks(params: {
  ddbMock: AwsClientStub<DynamoDBClient>;
  mockJwtVerify: Mock;
  sub: string;
  userId: string;
  orgId: string;
  email?: string;
  idTokenPayload?: Record<string, unknown>;
}) {
  const email = params.email ?? 'user@example.com';
  params.mockJwtVerify
    .mockResolvedValueOnce({ payload: { sub: params.sub } })
    .mockResolvedValueOnce({
      payload: { email, email_verified: true, ...(params.idTokenPayload ?? { amr: ['mfa'] }) },
    });

  params.ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `SUB#${params.sub}` }, sk: { S: 'IDENTITY' } },
    })
    .resolves({
      Item: {
        userId: { S: params.userId },
        orgId: { S: params.orgId },
        // Established user: skips the login-side trial-entitlement backfill
        // write, which would otherwise show up in PutItem assertions.
        emailEntitlementClaimed: { BOOL: true },
      },
    });

  params.ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${params.orgId}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: {
        orgConfirmed: { BOOL: true },
        auroraSetupStatus: { S: FINAL_SETUP_STATUS },
      },
    });
}
