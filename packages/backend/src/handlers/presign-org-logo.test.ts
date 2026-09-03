import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: vi.fn(),
  createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
}));

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.AWS_REGION = 'us-east-1';

import { handler } from './presign-org-logo.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function presignEvent(body: unknown) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: {
      userId: MOCK_USER_ID,
      orgId: MOCK_ORG_ID,
      email: MOCK_EMAIL,
      membership: NO_MEMBERSHIP,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
    rawPath: '/api/org/logo-upload-url',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function callerHolds(role: OrgRole) {
  stubMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID, role });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/org/logo-upload-url handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: true },
    });

    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      })
      .resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: MOCK_USER_ID },
          orgId: { S: MOCK_ORG_ID },
          emailEntitlementClaimed: { BOOL: true },
          profileEmail: { S: MOCK_EMAIL },
        },
      });

    mockGetSignedUrl.mockResolvedValue('https://org-logo-bucket.s3.us-east-1.amazonaws.com/signed');
    // authMiddleware's own deletion-fence read of the caller's active org
    // profile — unrelated to the logo this route presigns a home for.
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { name: { S: 'Active Org' } } });
    callerHolds(OrgRole.Owner);
  });

  it('returns an upload URL and the public URL it will be readable at', async () => {
    const result = await handler(presignEvent({ contentType: 'image/png' }), buildContext());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse((result as { body: string }).body);
    expect(body.uploadUrl).toBe('https://org-logo-bucket.s3.us-east-1.amazonaws.com/signed');
    expect(body.logoUrl).toMatch(
      /^https:\/\/OrgLogoBucket\.s3\.us-east-1\.amazonaws\.com\/logos\/[0-9a-f-]+$/,
    );
  });

  it('presigns a PUT with the requested content type', async () => {
    await handler(presignEvent({ contentType: 'image/webp' }), buildContext());

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, command] = mockGetSignedUrl.mock.calls[0];
    expect(command.input).toMatchObject({
      Bucket: 'OrgLogoBucket',
      ContentType: 'image/webp',
    });
  });

  it.each([['image/gif'], ['application/pdf'], ['']])(
    'rejects an unsupported content type (%s)',
    async (contentType) => {
      const result = await handler(presignEvent({ contentType }), buildContext());

      expect(result.statusCode).toBe(400);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a body with no content type', async () => {
    const result = await handler(presignEvent({}), buildContext());

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const result = await handler(presignEvent('not-json{'), buildContext());

    expect(result.statusCode).toBe(400);
  });

  it('refuses a caller with no membership in their own active org', async () => {
    stubAbsentMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID });

    const result = await handler(presignEvent({ contentType: 'image/png' }), buildContext());

    expect(result.statusCode).toBe(403);
  });

  it('lets a ReadOnly caller presign a logo upload', async () => {
    // No org exists yet to hold a role in — every role may ask for a place to
    // put a picture.
    callerHolds(OrgRole.ReadOnly);

    const result = await handler(presignEvent({ contentType: 'image/png' }), buildContext());

    expect(result.statusCode).toBe(200);
  });
});
