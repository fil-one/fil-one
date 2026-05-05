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

export interface MfaFactor {
  type: string;
}

export interface PostLoginEvent {
  user: {
    enrolledFactors?: MfaFactor[];
    app_metadata?: Record<string, unknown>;
  };
}

export interface PostLoginApi {
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
  const mfaTypes = new Set(['otp', 'webauthn-roaming', 'webauthn-platform', 'recovery-code']);
  const enrolledFactors = (event.user.enrolledFactors || []).filter((f) => mfaTypes.has(f.type));
  const hasMfa = enrolledFactors.length > 0;
  const mfaEnrolling = event.user.app_metadata?.mfa_enrolling === true;

  const factors: MfaFactor[] = [
    { type: 'otp' },
    { type: 'webauthn-roaming' },
    { type: 'webauthn-platform' },
  ];

  if (mfaEnrolling) {
    // User clicked "Enable" / "Add authenticator or key". Clear the flag so
    // subsequent logins don't re-trigger enrollment.
    api.user.setAppMetadata('mfa_enrolling', false);

    if (hasMfa) {
      // Auth0 requires an existing factor be challenged before enrolling a
      // new one — calling enrollWithAny alone on an already-enrolled user
      // returns "Something went wrong". challengeWithAny + enrollWithAny
      // queue in order within a single login transaction.
      api.authentication.challengeWithAny(factors);
    }

    api.authentication.enrollWithAny(factors);
    return;
  }

  if (hasMfa) {
    api.authentication.challengeWithAny(factors);
  }
}
