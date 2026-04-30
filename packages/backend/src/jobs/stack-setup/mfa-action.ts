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
  const allMfaTypes = new Set([
    'otp',
    'webauthn-roaming',
    'webauthn-platform',
    'email',
    'recovery-code',
  ]);
  // Auth0 auto-includes {type:'email'} in enrolledFactors for any user with a
  // verified email when the email factor is enabled tenant-wide — even if the
  // user never explicitly enrolled. Treat email as a real factor only when the
  // user opted in via the Settings page (which sets app_metadata.email_mfa_active).
  // Without this filter, every verified-email user is silently subjected to an
  // email MFA challenge on every login.
  const emailMfaActive = event.user.app_metadata?.email_mfa_active === true;
  const enrolledFactors = (event.user.enrolledFactors || []).filter((f) => {
    if (!allMfaTypes.has(f.type)) return false;
    if (f.type === 'email' && !emailMfaActive) return false;
    return true;
  });
  const hasMfa = enrolledFactors.length > 0;
  const mfaEnrolling = event.user.app_metadata?.mfa_enrolling === true;

  // Email is the weakest factor (same channel as password reset). Only allow
  // the email challenge when the user has nothing stronger enrolled and has
  // explicitly enabled email MFA — otherwise anyone with the password could
  // downgrade to email.
  const strongFactorTypes = new Set(['otp', 'webauthn-roaming', 'webauthn-platform']);
  const hasStrongFactor = enrolledFactors.some((f) => strongFactorTypes.has(f.type));
  const challengeTypes: MfaFactor[] = [
    { type: 'otp' },
    { type: 'webauthn-roaming' },
    { type: 'webauthn-platform' },
  ];
  if (!hasStrongFactor && emailMfaActive) {
    challengeTypes.push({ type: 'email' });
  }

  if (mfaEnrolling) {
    // User clicked "Enable" / "Add authenticator or key". Clear the flag so
    // subsequent logins don't re-trigger enrollment.
    api.user.setAppMetadata('mfa_enrolling', false);

    if (hasMfa) {
      // Auth0 requires an existing factor be challenged before enrolling a
      // new one — calling enrollWithAny alone on an already-enrolled user
      // returns "Something went wrong". challengeWithAny + enrollWithAny
      // queue in order within a single login transaction.
      api.authentication.challengeWithAny(challengeTypes);
    }

    api.authentication.enrollWithAny([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'webauthn-platform' },
    ]);
    return;
  }

  if (hasMfa) {
    api.authentication.challengeWithAny(challengeTypes);
  }
  // No MFA enrolled and not enrolling — skip MFA.
}
