import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AwsClientStub } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { vi, type Mock } from 'vitest';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';
import { buildEvent } from './lambda-test-utilities.js';

/**
 * Shared scaffolding for tests that drive a handler through the full middy
 * stack instead of calling `baseHandler` directly. The `vi.mock(...)` calls
 * must stay in each test file (vitest hoists them); only the module shapes
 * live here, so use the async factory form:
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
 * Module factory for `vi.mock('../lib/auth0-management.js', ...)`. Re-exports
 * the REAL `MFA_GUARDIAN_TYPES` so the mock can't drift from it; `extras`
 * covers any further exports the handler under test consumes.
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
 * Request event as the middy stack sees it: auth cookies plus a matching CSRF
 * pair. No `userInfo` — authMiddleware resolves it from the mocked identity row.
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
  // The cast is the shape the middy handler type expects; authMiddleware
  // populates userInfo at runtime.
  return event as unknown as APIGatewayProxyEventV2 & AuthenticatedEvent;
}

/**
 * authMiddleware's two jwtVerify resolutions (access token, then ID token) and
 * its SUB#/IDENTITY + ORG#/PROFILE reads. `idTokenPayload` drives the claims
 * the step-up gates read (e.g. `{ amr: ['pwd'] }`). The test file must set
 * `AUTH0_DOMAIN`/`AUTH0_AUDIENCE` before importing the handler module.
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
        // Established user: skips the trial-entitlement backfill write, which
        // would otherwise show up in PutItem assertions.
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
