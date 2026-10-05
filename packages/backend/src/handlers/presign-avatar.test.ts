import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

vi.mock('../lib/auth-secrets.ts', () => ({
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

const mockCreatePresignedPost = vi.fn();
vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: (...args: unknown[]) => mockCreatePresignedPost(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.AWS_REGION = 'us-east-1';

import { handler } from './presign-avatar.ts';
import { buildEvent, buildContext, stubMembershipRead } from '../test/lambda-test-utilities.ts';
import { AVATAR_MAX_BYTES, OrgRole } from '@filone/shared';

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
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
    rawPath: '/api/me/avatar-upload-url',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/me/avatar-upload-url handler', () => {
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

    mockCreatePresignedPost.mockResolvedValue({
      url: 'https://org-logo-bucket.s3.us-east-1.amazonaws.com/signed',
      fields: { key: 'avatars/mock', policy: 'mock-policy', signature: 'mock-signature' },
    });
    // authMiddleware's own deletion-fence read of the caller's active org
    // profile — unrelated to the avatar this route presigns a home for.
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { name: { S: 'Active Org' } } });
    stubMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID, role: OrgRole.Owner });
  });

  it('returns an upload URL and the public URL it will be readable at', async () => {
    const result = await handler(presignEvent({ contentType: 'image/png' }), buildContext());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse((result as { body: string }).body);
    expect(body).toEqual({
      uploadUrl: 'https://org-logo-bucket.s3.us-east-1.amazonaws.com/signed',
      fields: { key: 'avatars/mock', policy: 'mock-policy', signature: 'mock-signature' },
      pictureUrl: expect.stringMatching(
        /^https:\/\/OrgLogoBucket\.s3\.us-east-1\.amazonaws\.com\/avatars\/[0-9a-f-]+$/,
      ),
    });
  });

  it('presigns a tagged POST with the requested content type and a size ceiling', async () => {
    await handler(presignEvent({ contentType: 'image/webp' }), buildContext());

    expect(mockCreatePresignedPost).toHaveBeenCalledTimes(1);
    const [, options] = mockCreatePresignedPost.mock.calls[0];
    // A POST policy, unlike a presigned PUT, lets S3 itself refuse an oversized
    // file. Tagged on the way in, so the bucket's lifecycle rule expires it
    // unless a save claims it; the policy binds the tag, so a client can't drop it.
    const tagging =
      '<Tagging><TagSet><Tag><Key>state</Key><Value>unclaimed</Value></Tag></TagSet></Tagging>';
    expect(options).toEqual({
      Bucket: 'OrgLogoBucket',
      Key: expect.stringMatching(/^avatars\/[0-9a-f-]+$/),
      Conditions: [
        ['content-length-range', 1, AVATAR_MAX_BYTES],
        ['eq', '$Content-Type', 'image/webp'],
        ['eq', '$tagging', tagging],
      ],
      Fields: { 'Content-Type': 'image/webp', tagging },
      Expires: 300,
    });
  });

  it.each<[string, unknown]>([
    ['an unsupported content type (image/gif)', { contentType: 'image/gif' }],
    ['an unsupported content type (application/pdf)', { contentType: 'application/pdf' }],
    ['an empty content type', { contentType: '' }],
    ['a body with no content type', {}],
    ['invalid JSON', 'not-json{'],
  ])('returns 400 for %s', async (_label, body) => {
    const result = await handler(presignEvent(body), buildContext());

    expect(result.statusCode).toBe(400);
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });

  it('returns 429, and presigns nothing, once the caller has used the hour up', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'limit', $metadata: {} }));

    const result = await handler(presignEvent({ contentType: 'image/png' }), buildContext());

    expect(result).toMatchObject({ statusCode: 429 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({
      code: 'IMAGE_UPLOAD_RATE_LIMITED',
    });
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });
});
