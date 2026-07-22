import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
  },
}));

const mockReadDeletionRecord = vi.fn();
vi.mock('../lib/deletion-record.js', () => ({
  readDeletionRecord: (orgId: string) => mockReadDeletionRecord(orgId),
}));

const mockCreateChallenge = vi.fn();
vi.mock('../lib/deletion-challenge.js', () => ({
  createDeletionChallenge: (orgId: string) => mockCreateChallenge(orgId),
}));

const mockSendEmail = vi.fn();
vi.mock('../lib/deletion-email.js', () => ({
  sendDeletionCodeEmail: (params: unknown) => mockSendEmail(params),
}));

const mockGetOrgProfile = vi.fn();
vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: (orgId: string) => mockGetOrgProfile(orgId),
}));

import { baseHandler } from './create-deletion-challenge.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const ORG_ID = 'org-1';

function makeEvent(email?: string | null) {
  return buildEvent({
    method: 'POST',
    userInfo: {
      sub: 'auth0|sub-1',
      userId: 'user-1',
      orgId: ORG_ID,
      ...(email === null ? {} : { email: email ?? 'user@example.com' }),
    },
  });
}

describe('create-deletion-challenge baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDeletionRecord.mockResolvedValue(undefined);
    mockGetOrgProfile.mockResolvedValue({ name: { S: 'Acme Corp' } });
    mockCreateChallenge.mockResolvedValue({
      outcome: 'created',
      code: '123456',
      expiresAt: '2026-07-10T00:15:00.000Z',
      resendAvailableAt: '2026-07-10T00:01:00.000Z',
    });
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('returns 409 when a deletion is already in progress', async () => {
    mockReadDeletionRecord.mockResolvedValue({ status: 'PENDING' });

    const result = (await baseHandler(makeEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(409);
    expect(mockCreateChallenge).not.toHaveBeenCalled();
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
      expiresAt: '2026-07-10T00:15:00.000Z',
      resendAvailableAt: '2026-07-10T00:01:00.000Z',
    });
  });

  it('propagates a SendGrid failure instead of silently succeeding', async () => {
    mockSendEmail.mockRejectedValue(new Error('SendGrid send failed (500)'));

    await expect(baseHandler(makeEvent())).rejects.toThrow('SendGrid send failed');
  });
});
