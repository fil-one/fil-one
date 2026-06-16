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

// MFA factor types this Action recognizes. The `(string & {})` keeps the
// field assignable from any string (Auth0 may emit 'email', 'sms', etc. on
// incoming events) while preserving autocomplete for the known set when
// constructing factor arrays.
export type MfaFactorType = 'otp' | 'webauthn-roaming' | 'webauthn-platform' | 'recovery-code';

export interface MfaFactor {
  type: MfaFactorType | (string & {});
}

export interface AuthenticationMethod {
  name: string;
  timestamp?: string;
}

export interface PostLoginEvent {
  user: {
    enrolledFactors?: MfaFactor[];
    app_metadata?: Record<string, unknown>;
  };
  authentication?: {
    methods?: AuthenticationMethod[];
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
  const mfaTypes = new Set<string>([
    'otp',
    'webauthn-roaming',
    'webauthn-platform',
    'recovery-code',
  ] satisfies MfaFactorType[]);
  const enrolledFactors = (event.user.enrolledFactors || []).filter((f) => mfaTypes.has(f.type));
  const hasMfa = enrolledFactors.length > 0;
  const authMethods = event.authentication?.methods || [];
  const usedRecoveryCode = authMethods.some((m) => m.name === 'recovery-code');
  // Auth0 emits the primary-passkey login as `name: 'passkey'` on
  // event.authentication.methods. (Note: `performed_amr: 'phr'` is a
  // tenant-log field, not exposed to the Action runtime — only `name` and
  // `timestamp` are.) Auth0 has used other strings historically for MFA
  // WebAuthn (`webauthn`, etc.), but primary-passkey-on-connection logins
  // come through as `'passkey'`. The request-time counterpart is the ID
  // token's `amr` claim (`phr`), read by require-mfa.ts — the two must agree.
  const usedPasskey = authMethods.some((m) => m.name === 'passkey');

  // Recovery-code redemption means the user just lost their device. Force
  // re-enrollment of a fresh strong factor on this same login transaction.
  const mfaEnrolling = event.user.app_metadata?.mfa_enrolling === true || usedRecoveryCode;

  // Passkey logins are phishing-resistant and user-verifying; treat them as
  // satisfying MFA so a user who signed in with a passkey isn't double-
  // challenged. Matches the industry pattern (GitHub, Google, Microsoft).
  // EXCEPTION: when the user is actively enrolling (clicked "Add MFA" or
  // just redeemed a recovery code), fall through to the enrollment branch
  // below — otherwise the enroll button silently no-ops for passkey users.
  if (usedPasskey && !mfaEnrolling) return;

  // Strong factors users can enroll in. Recovery code is auto-issued by
  // Auth0 when one of these is enrolled — never enrolled directly.
  const enrollableFactors: MfaFactor[] = [
    { type: 'otp' },
    { type: 'webauthn-roaming' },
    { type: 'webauthn-platform' },
  ];

  // Factors offered on the MFA challenge screen. Recovery code must be listed
  // here so Universal Login surfaces "Use a recovery code" as an option —
  // enabling the factor tenant-wide is not enough on its own.
  const challengeFactors: MfaFactor[] = [...enrollableFactors, { type: 'recovery-code' }];

  if (mfaEnrolling) {
    // User clicked "Enable" / "Add authenticator or key", or just redeemed a
    // recovery code. Clear the flag so subsequent logins don't re-trigger.
    api.user.setAppMetadata('mfa_enrolling', false);

    if (hasMfa && !usedRecoveryCode) {
      // Auth0 requires an existing factor be challenged before enrolling a
      // new one — calling enrollWithAny alone on an already-enrolled user
      // returns "Something went wrong". challengeWithAny + enrollWithAny
      // queue in order within a single login transaction. Skip this when the
      // user just redeemed a recovery code: that redemption already satisfied
      // the challenge requirement, and the strong factor on file (the lost
      // device) cannot actually respond to a challenge.
      api.authentication.challengeWithAny(challengeFactors);
    }

    api.authentication.enrollWithAny(enrollableFactors);
    return;
  }

  if (hasMfa) {
    api.authentication.challengeWithAny(challengeFactors);
  }
}
