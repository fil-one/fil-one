import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

import { onExecutePostLogin } from './mfa-action.js';
import type { PostLoginApi, PostLoginEvent } from './mfa-action.js';

interface CapturedApi extends PostLoginApi {
  authentication: {
    enrollWithAny: Mock<PostLoginApi['authentication']['enrollWithAny']>;
    challengeWithAny: Mock<PostLoginApi['authentication']['challengeWithAny']>;
  };
  user: {
    setAppMetadata: Mock<PostLoginApi['user']['setAppMetadata']>;
  };
}

function buildApi(): CapturedApi {
  return {
    authentication: {
      enrollWithAny: vi.fn(),
      challengeWithAny: vi.fn(),
    },
    user: {
      setAppMetadata: vi.fn(),
    },
  };
}

function buildEvent(opts: {
  enrolledFactors?: { type: string }[];
  mfaEnrolling?: boolean;
}): PostLoginEvent {
  return {
    user: {
      enrolledFactors: opts.enrolledFactors,
      app_metadata: opts.mfaEnrolling === undefined ? {} : { mfa_enrolling: opts.mfaEnrolling },
    },
  };
}

describe('onExecutePostLogin', () => {
  let api: CapturedApi;

  beforeEach(() => {
    api = buildApi();
  });

  it('skips MFA entirely when user has no factors and is not enrolling', async () => {
    await onExecutePostLogin(buildEvent({ enrolledFactors: [] }), api);

    expect(api.authentication.enrollWithAny).not.toHaveBeenCalled();
    expect(api.authentication.challengeWithAny).not.toHaveBeenCalled();
    expect(api.user.setAppMetadata).not.toHaveBeenCalled();
  });

  it('triggers strong-factor enrollment when mfa_enrolling is set and no factor exists', async () => {
    await onExecutePostLogin(buildEvent({ enrolledFactors: [], mfaEnrolling: true }), api);

    expect(api.authentication.enrollWithAny).toHaveBeenCalledWith([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'webauthn-platform' },
    ]);
    expect(api.authentication.challengeWithAny).not.toHaveBeenCalled();
  });

  it('clears the enrolling flag and challenges when mfa_enrolling and a factor exist', async () => {
    await onExecutePostLogin(
      buildEvent({ enrolledFactors: [{ type: 'otp' }], mfaEnrolling: true }),
      api,
    );

    expect(api.user.setAppMetadata).toHaveBeenCalledWith('mfa_enrolling', false);
    expect(api.authentication.challengeWithAny).toHaveBeenCalled();
  });

  it('challenges with email only when email is the only enrolled factor', async () => {
    await onExecutePostLogin(buildEvent({ enrolledFactors: [{ type: 'email' }] }), api);

    expect(api.authentication.challengeWithAny).toHaveBeenCalledWith([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'webauthn-platform' },
      { type: 'email' },
    ]);
  });

  it('excludes email from challenge when a strong factor is enrolled', async () => {
    await onExecutePostLogin(
      buildEvent({ enrolledFactors: [{ type: 'otp' }, { type: 'email' }] }),
      api,
    );

    expect(api.authentication.challengeWithAny).toHaveBeenCalledWith([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'webauthn-platform' },
    ]);
  });

  it.each([['webauthn-roaming'], ['webauthn-platform'], ['otp']])(
    'excludes email from challenge when %s is enrolled alongside email',
    async (strongFactor) => {
      await onExecutePostLogin(
        buildEvent({ enrolledFactors: [{ type: strongFactor }, { type: 'email' }] }),
        api,
      );

      expect(api.authentication.challengeWithAny).toHaveBeenCalledWith([
        { type: 'otp' },
        { type: 'webauthn-roaming' },
        { type: 'webauthn-platform' },
      ]);
    },
  );

  it('ignores recovery-code when deciding the challenge list', async () => {
    await onExecutePostLogin(
      buildEvent({ enrolledFactors: [{ type: 'email' }, { type: 'recovery-code' }] }),
      api,
    );

    expect(api.authentication.challengeWithAny).toHaveBeenCalledWith([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'webauthn-platform' },
      { type: 'email' },
    ]);
  });

  it('ignores unknown factor types when computing hasMfa', async () => {
    await onExecutePostLogin(buildEvent({ enrolledFactors: [{ type: 'sms' }] }), api);

    expect(api.authentication.enrollWithAny).not.toHaveBeenCalled();
    expect(api.authentication.challengeWithAny).not.toHaveBeenCalled();
  });

  it('handles missing enrolledFactors array', async () => {
    await onExecutePostLogin({ user: { app_metadata: {} } }, api);

    expect(api.authentication.enrollWithAny).not.toHaveBeenCalled();
    expect(api.authentication.challengeWithAny).not.toHaveBeenCalled();
  });
});
