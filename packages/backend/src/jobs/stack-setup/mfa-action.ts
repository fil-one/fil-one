/**
 * Auth0 Post-Login Action for MFA enrollment and challenge.
 *
 * This file is type-checked at build time via the interfaces below, then
 * serialized to a string at runtime via Function.prototype.toString().
 * The resulting JS is deployed to Auth0 as a Post-Login Action.
 *
 * Do NOT import any modules here — Auth0 Actions run in an isolated sandbox
 * with only Node.js built-ins and explicitly declared dependencies.
 */

// ── Auth0 Action runtime types ──────────────────────────────────────────

interface MfaFactor {
  type: string;
}

interface PostLoginEvent {
  user: {
    enrolledFactors?: MfaFactor[];
    app_metadata?: Record<string, unknown>;
  };
}

interface PostLoginApi {
  authentication: {
    enrollWithAny(factors: MfaFactor[]): void;
    challengeWithAny(factors: MfaFactor[]): void;
  };
  user: {
    setAppMetadata(key: string, value: unknown): void;
  };
}

// ── Action handler ──────────────────────────────────────────────────────

export async function onExecutePostLogin(event: PostLoginEvent, api: PostLoginApi): Promise<void> {
  const allMfaTypes = new Set([
    'otp',
    'webauthn-roaming',
    'webauthn-platform',
    'email',
    'recovery-code',
  ]);
  const enrolledFactors = (event.user.enrolledFactors || []).filter((f) => allMfaTypes.has(f.type));
  const hasMfa = enrolledFactors.length > 0;
  const mfaEnrolling = event.user.app_metadata?.mfa_enrolling === true;

  const challengeTypes: MfaFactor[] = [
    { type: 'otp' },
    { type: 'webauthn-roaming' },
    { type: 'webauthn-platform' },
    { type: 'email' },
  ];

  if (mfaEnrolling && !hasMfa) {
    // User clicked "Enable with authenticator/key" — let them choose.
    // Email enrollment is handled server-side via the Management API,
    // not via Actions, so it is not offered here.
    api.authentication.enrollWithAny([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'webauthn-platform' },
    ]);
  } else if (mfaEnrolling && hasMfa) {
    // Already enrolled (e.g. re-login after enrolling). Clear the flag and challenge.
    api.user.setAppMetadata('mfa_enrolling', false);
    api.authentication.challengeWithAny(challengeTypes);
  } else if (hasMfa) {
    // Normal login for enrolled user — challenge with any enrolled factor
    // (including email-only users who enrolled via the Management API).
    api.authentication.challengeWithAny(challengeTypes);
  }
  // No MFA enrolled and not enrolling — skip MFA.
}
