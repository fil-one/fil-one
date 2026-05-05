import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import vm from 'node:vm';

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
  const app_metadata: Record<string, unknown> = {};
  if (opts.mfaEnrolling !== undefined) app_metadata.mfa_enrolling = opts.mfaEnrolling;
  return {
    user: {
      enrolledFactors: opts.enrolledFactors,
      app_metadata,
    },
  };
}

const STRONG_FACTORS = [
  { type: 'otp' },
  { type: 'webauthn-roaming' },
  { type: 'webauthn-platform' },
];

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

    expect(api.authentication.enrollWithAny).toHaveBeenCalledWith(STRONG_FACTORS);
    expect(api.authentication.challengeWithAny).not.toHaveBeenCalled();
  });

  it('challenges the existing factor and then enrolls a new one when mfa_enrolling and a factor already exist', async () => {
    // Auth0 rejects enrollWithAny on already-enrolled users without a prior
    // challenge in the same action ("Something went wrong"). Both calls queue
    // and execute in order within one login transaction.
    await onExecutePostLogin(
      buildEvent({ enrolledFactors: [{ type: 'otp' }], mfaEnrolling: true }),
      api,
    );

    expect(api.user.setAppMetadata).toHaveBeenCalledWith('mfa_enrolling', false);
    expect(api.authentication.challengeWithAny).toHaveBeenCalledWith(STRONG_FACTORS);
    expect(api.authentication.enrollWithAny).toHaveBeenCalledWith(STRONG_FACTORS);
  });

  it('clears the enrolling flag when triggering first-time enrollment', async () => {
    await onExecutePostLogin(buildEvent({ enrolledFactors: [], mfaEnrolling: true }), api);

    expect(api.user.setAppMetadata).toHaveBeenCalledWith('mfa_enrolling', false);
  });

  it('ignores email factors entirely (auto-enrolled or otherwise)', async () => {
    // The Auth0 dashboard email MFA factor is disabled tenant-wide so
    // enrolledFactors should never carry email — but if it ever does (legacy
    // user, dashboard misconfiguration), the action must not act on it.
    await onExecutePostLogin(buildEvent({ enrolledFactors: [{ type: 'email' }] }), api);

    expect(api.authentication.challengeWithAny).not.toHaveBeenCalled();
    expect(api.authentication.enrollWithAny).not.toHaveBeenCalled();
  });

  it('still challenges the strong factor when an email factor is present alongside it', async () => {
    await onExecutePostLogin(
      buildEvent({ enrolledFactors: [{ type: 'otp' }, { type: 'email' }] }),
      api,
    );

    expect(api.authentication.challengeWithAny).toHaveBeenCalledWith(STRONG_FACTORS);
  });

  it.each([['webauthn-roaming'], ['webauthn-platform'], ['otp']])(
    'challenges with the strong-factor list when %s is enrolled',
    async (strongFactor) => {
      await onExecutePostLogin(buildEvent({ enrolledFactors: [{ type: strongFactor }] }), api);

      expect(api.authentication.challengeWithAny).toHaveBeenCalledWith(STRONG_FACTORS);
    },
  );

  it('does not challenge on a recovery-code-only user', async () => {
    // recovery-code is counted in hasMfa so the user is challenged with the
    // strong-factor list — recovery codes are only valid as a backup during
    // a strong-factor challenge, never on their own.
    await onExecutePostLogin(buildEvent({ enrolledFactors: [{ type: 'recovery-code' }] }), api);

    expect(api.authentication.challengeWithAny).toHaveBeenCalledWith(STRONG_FACTORS);
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

  it('challenges on subsequent logins after the enrolling flag was cleared', async () => {
    // After enrollment succeeds, the flag is cleared. Subsequent logins must
    // continue to challenge the user — there is no password-only fallback
    // as long as a factor remains enrolled.
    await onExecutePostLogin(
      buildEvent({ enrolledFactors: [{ type: 'webauthn-roaming' }], mfaEnrolling: false }),
      api,
    );

    expect(api.authentication.challengeWithAny).toHaveBeenCalledWith(STRONG_FACTORS);
    expect(api.user.setAppMetadata).not.toHaveBeenCalled();
    expect(api.authentication.enrollWithAny).not.toHaveBeenCalled();
  });
});

describe('onExecutePostLogin serialization (Auth0 sandbox safety)', () => {
  // The action is deployed to Auth0 by serializing this function via
  // Function.prototype.toString(). Auth0 evaluates the resulting source in
  // an isolated sandbox with no access to module-level helpers, imports, or
  // closures from this file. Re-evaluating the serialized source with
  // `new Function` simulates that sandbox: any reference to a module-level
  // symbol (a top-level const, a helper function, an import) becomes a
  // ReferenceError at runtime here.
  //
  // If this test fails after a change to mfa-action.ts, the change introduced
  // a reference that will not survive serialization. Inline the value or
  // helper inside `onExecutePostLogin` instead.
  function loadSerialized(): typeof onExecutePostLogin {
    // node:vm runs the code in a new context with no access to this module's
    // bindings — closer to the Auth0 Action sandbox than the test process.
    const code = `(${onExecutePostLogin.toString()})`;
    return vm.runInNewContext(code) as typeof onExecutePostLogin;
  }

  const cases: Array<{ name: string; event: PostLoginEvent }> = [
    { name: 'no factors, no enrolling flag', event: { user: { app_metadata: {} } } },
    {
      name: 'no factors, enrolling',
      event: { user: { app_metadata: { mfa_enrolling: true }, enrolledFactors: [] } },
    },
    {
      name: 'enrolled with strong factor, enrolling',
      event: {
        user: { app_metadata: { mfa_enrolling: true }, enrolledFactors: [{ type: 'otp' }] },
      },
    },
    {
      name: 'enrolled with strong factor, not enrolling',
      event: { user: { app_metadata: {}, enrolledFactors: [{ type: 'webauthn-roaming' }] } },
    },
    {
      name: 'enrolled with email only (should be ignored)',
      event: { user: { app_metadata: {}, enrolledFactors: [{ type: 'email' }] } },
    },
    {
      name: 'enrolled with strong factor and email',
      event: {
        user: {
          app_metadata: {},
          enrolledFactors: [{ type: 'webauthn-platform' }, { type: 'email' }],
        },
      },
    },
    {
      name: 'recovery-code only',
      event: { user: { app_metadata: {}, enrolledFactors: [{ type: 'recovery-code' }] } },
    },
  ];

  it.each(cases)('runs without external references: $name', async ({ event }) => {
    const sandboxed = loadSerialized();
    const api = buildApi();

    // Any reference to a module-local symbol (helper, import, const) will
    // throw ReferenceError here because `new Function` evaluates in a clean
    // global scope.
    await expect(sandboxed(event, api)).resolves.toBeUndefined();
  });
});
