import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiErrorCode } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const mockIsOrgAdmin = vi.fn(async () => true);
vi.mock('../lib/org-membership.js', () => ({
  isOrgAdmin: () => mockIsOrgAdmin(),
}));

const mockIsOrgDeleting = vi.fn(async (_orgId: string, _o?: { consistent?: boolean }) => false);
const mockGetOrgProfile = vi.fn(async () => ({ name: { S: 'Acme Corp' } }));
vi.mock('../lib/org-profile.js', () => ({
  isOrgDeleting: (...args: Parameters<typeof mockIsOrgDeleting>) => mockIsOrgDeleting(...args),
  getOrgProfile: () => mockGetOrgProfile(),
}));

const mockCreateChallenge = vi.fn();
vi.mock('../lib/deletion-challenge.js', () => ({
  createDeletionChallenge: (...args: unknown[]) => mockCreateChallenge(...args),
}));

const mockSendEmail = vi.fn(async (_args: unknown) => undefined);
vi.mock('../lib/deletion-email.js', () => ({
  sendDeletionCodeEmail: (args: unknown) => mockSendEmail(args),
}));

import { baseHandler } from './request-account-deletion.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const USER_INFO = {
  userId: 'user-1',
  orgId: 'org-1',
  email: 'admin@example.com',
  emailVerified: true,
};

const event = () => buildEvent({ userInfo: USER_INFO, method: 'POST' });

const CREATED = {
  outcome: 'created' as const,
  code: '123456',
  expiresAt: '2026-08-12T10:15:00.000Z',
  resendAvailableAt: '2026-08-12T10:01:00.000Z',
};

describe('request-account-deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOrgAdmin.mockResolvedValue(true);
    mockIsOrgDeleting.mockResolvedValue(false);
    mockGetOrgProfile.mockResolvedValue({ name: { S: 'Acme Corp' } });
    mockCreateChallenge.mockResolvedValue(CREATED);
  });

  it('emails the code and returns when it expires and when a resend is allowed', async () => {
    const result = await baseHandler(event());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({
      outcome: 'challenge_created',
      expiresAt: CREATED.expiresAt,
      resendAvailableAt: CREATED.resendAvailableAt,
    });
    expect(mockSendEmail).toHaveBeenCalledWith({
      to: 'admin@example.com',
      orgName: 'Acme Corp',
      code: '123456',
    });
  });

  it('never returns the code to the caller', async () => {
    const result = await baseHandler(event());

    expect(result.body).not.toContain('123456');
  });

  it('403s a non-admin without issuing anything', async () => {
    mockIsOrgAdmin.mockResolvedValue(false);

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(403);
    expect(mockCreateChallenge).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  // Issuing another code would imply the deletion can still be stopped.
  it('reports deletion_in_progress once the fence is up', async () => {
    mockIsOrgDeleting.mockResolvedValue(true);

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ outcome: 'deletion_in_progress' });
    expect(mockCreateChallenge).not.toHaveBeenCalled();
  });

  it('reads the fence consistently', async () => {
    await baseHandler(event());

    expect(mockIsOrgDeleting).toHaveBeenCalledWith('org-1', { consistent: true });
  });

  it('429s with a retry time when the cooldown is still running', async () => {
    mockCreateChallenge.mockResolvedValue({
      outcome: 'rate_limited',
      resendAvailableAt: '2026-08-12T10:01:00.000Z',
    });

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(429);
    expect(JSON.parse(result.body!)).toMatchObject({
      code: ApiErrorCode.DELETION_RATE_LIMITED,
      resendAvailableAt: '2026-08-12T10:01:00.000Z',
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('403s when the session email is unverified', async () => {
    const unverified = buildEvent({
      userInfo: { ...USER_INFO, emailVerified: false },
      method: 'POST',
    });

    const result = await baseHandler(unverified);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.EMAIL_NOT_VERIFIED);
    expect(mockCreateChallenge).not.toHaveBeenCalled();
  });
});
