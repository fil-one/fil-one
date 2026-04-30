import { Resource } from 'sst';

function getDomain(): string {
  return process.env.AUTH0_DOMAIN!;
}

/** Canonical tenant domain for Management API — custom domains don't support /api/v2/. */
function getMgmtDomain(): string {
  return process.env.AUTH0_MGMT_DOMAIN ?? process.env.AUTH0_DOMAIN!;
}

// Module-level token cache — reused across Lambda warm starts.
// Management tokens are not user-specific, so caching is safe.
let cachedMgmtToken: { token: string; expiresAt: number } | null = null;

async function getManagementToken(): Promise<string> {
  const now = Date.now();
  if (cachedMgmtToken && now < cachedMgmtToken.expiresAt) {
    return cachedMgmtToken.token;
  }

  const domain = getMgmtDomain();
  const resp = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: Resource.Auth0MgmtRuntimeClientId.value,
      client_secret: Resource.Auth0MgmtRuntimeClientSecret.value,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 management token request failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  // Cache with 60-second buffer before actual expiry
  cachedMgmtToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

export async function updateAuth0User(sub: string, data: Record<string, unknown>): Promise<void> {
  const domain = getMgmtDomain();
  const token = await getManagementToken();
  const resp = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(sub)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 update user failed (${resp.status}): ${body}`);
  }
}

/**
 * Trigger Auth0 to send a verification email to the user.
 * Requires the `create:user_tickets` scope on the M2M app.
 */
export async function sendVerificationEmail(sub: string): Promise<void> {
  const domain = getMgmtDomain();
  const token = await getManagementToken();
  const resp = await fetch(`https://${domain}/api/v2/jobs/verification-email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: sub,
      client_id: Resource.Auth0ClientId.value,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error('[auth0] Failed to send verification email', { status: resp.status, body });
    throw new Error(`Auth0 send verification email failed (${resp.status}): ${body}`);
  }
}

/**
 * Initiate an Auth0 password reset email for a database-connection user.
 */
export async function initiatePasswordReset(email: string, clientId: string): Promise<void> {
  const domain = getDomain();
  const resp = await fetch(`https://${domain}/dbconnections/change_password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      email,
      connection: 'Username-Password-Authentication',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 change_password failed (${resp.status}): ${body}`);
  }
}

/**
 * Derive connection type from the Auth0 sub claim prefix.
 * e.g. "auth0|abc123" → "auth0", "google-oauth2|abc" → "google-oauth2"
 */
export function getConnectionType(sub: string): string {
  const pipeIndex = sub.indexOf('|');
  if (pipeIndex === -1) return 'unknown';
  return sub.substring(0, pipeIndex);
}

// ── MFA Management ──────────────────────────────────────────────────────

/**
 * Set app_metadata.mfa_enrolling = true so the Post-Login Action
 * triggers enrollment on the next login. The Action clears this
 * flag after successful enrollment.
 */
export async function flagMfaEnrollment(sub: string): Promise<void> {
  await updateAuth0User(sub, {
    app_metadata: { mfa_enrolling: true },
  });
}

/**
 * Mark whether the user has explicitly opted into email MFA.
 *
 * Auth0 silently auto-enrolls every verified-email user into email MFA when
 * the email factor is enabled tenant-wide, so `event.user.enrolledFactors` is
 * not a reliable signal of intent. The Post-Login Action treats email as a
 * real factor only when this flag is true. Set it on explicit enrollment via
 * the Settings page; clear it whenever the email factor is removed.
 */
export async function setEmailMfaActive(sub: string, active: boolean): Promise<void> {
  await updateAuth0User(sub, {
    app_metadata: { email_mfa_active: active },
  });
}

export interface GuardianEnrollment {
  id: string;
  type: string;
  status: string;
  name?: string;
  enrolled_at?: string;
  /**
   * Which Auth0 endpoint this entry came from. Determines which delete
   * endpoint to use:
   *   - 'guardian'     → DELETE /api/v2/guardian/enrollments/{id}
   *   - 'auth-methods' → DELETE /api/v2/users/{sub}/authentication-methods/{id}
   * The two endpoints assign different ids for the same factor, so the source
   * cannot be inferred from `id` alone.
   */
  source?: 'guardian' | 'auth-methods';
}

// Guardian enrollment types that count as MFA (excludes auto-enrolled email)
export const MFA_GUARDIAN_TYPES = new Set([
  'authenticator',
  'webauthn-roaming',
  'webauthn-platform',
]);

interface Auth0AuthenticationMethod {
  id: string;
  type: string;
  name?: string;
  email?: string;
  confirmed?: boolean;
  created_at?: string;
}

/**
 * Map a row from /authentication-methods into the shared GuardianEnrollment
 * shape, or return null if the row should not surface in settings.
 *
 * Auth0 reports TOTP as `type: 'totp'`; we normalize it to `'authenticator'`
 * so the UI, action, and existing type definitions stay unchanged.
 */
function authMethodToEnrollment(
  m: Auth0AuthenticationMethod,
  includeEmail: boolean,
): GuardianEnrollment | null {
  if (m.confirmed === false) return null;

  const base = {
    id: m.id,
    status: 'confirmed' as const,
    name: m.name,
    enrolled_at: m.created_at,
    source: 'auth-methods' as const,
  };

  if (m.type === 'totp') return { ...base, type: 'authenticator' };
  if (m.type === 'webauthn-roaming' || m.type === 'webauthn-platform') {
    return { ...base, type: m.type };
  }
  if (m.type === 'email' && includeEmail) {
    return { ...base, type: 'email', name: m.name ?? m.email };
  }
  return null;
}

/**
 * List MFA enrollments for a user.
 *
 * Auth0 splits MFA factors across two endpoints:
 *   - /api/v2/users/{id}/enrollments  (Guardian, legacy)
 *   - /api/v2/users/{id}/authentication-methods  (the unified, modern endpoint)
 *
 * Modern Auth0 puts every factor in /authentication-methods (TOTP appears as
 * `type: 'totp'`, WebAuthn as `webauthn-roaming`/`webauthn-platform`, email as
 * `email`). Guardian is only kept around for users with legacy enrollments
 * that were never migrated. We prefer the modern source so newly-added factors
 * (which Auth0 no longer mirrors into Guardian) are visible — without that,
 * a user who enrolls TOTP after a WebAuthn factor will have their TOTP
 * dropped from the settings UI.
 *
 * Each result is tagged with its source so the delete handlers know which
 * endpoint to call (the two endpoints use different ids for the same factor).
 */
export async function getMfaEnrollments(
  sub: string,
  options?: { includeEmail?: boolean },
): Promise<GuardianEnrollment[]> {
  const domain = getDomain();
  const token = await getManagementToken();
  const headers = { Authorization: `Bearer ${token}` };
  const userPath = `/api/v2/users/${encodeURIComponent(sub)}`;

  const [guardianResp, methodsResp] = await Promise.all([
    fetch(`https://${domain}${userPath}/enrollments`, { headers }),
    fetch(`https://${domain}${userPath}/authentication-methods`, { headers }),
  ]);

  if (!guardianResp.ok) {
    const body = await guardianResp.text();
    throw new Error(`Auth0 list enrollments failed (${guardianResp.status}): ${body}`);
  }
  if (!methodsResp.ok) {
    const body = await methodsResp.text();
    throw new Error(`Auth0 list authentication methods failed (${methodsResp.status}): ${body}`);
  }

  const guardianEnrollments = (await guardianResp.json()) as GuardianEnrollment[];
  const methods = (await methodsResp.json()) as Auth0AuthenticationMethod[];
  const includeEmail = options?.includeEmail === true;

  // Pull everything from /authentication-methods first — modern source, with
  // ids that route to the auth-methods delete endpoint.
  const result = methods
    .map((m) => authMethodToEnrollment(m, includeEmail))
    .filter((e): e is GuardianEnrollment => e !== null);

  // Fallback: if /authentication-methods has no TOTP but Guardian does, the
  // user has a legacy Guardian-only enrollment. Surface it so they can still
  // see and delete it. Skipped when a modern record is present (Auth0
  // sometimes mirrors, in which case we'd otherwise show duplicates).
  const hasAuthenticator = result.some((e) => e.type === 'authenticator');
  if (!hasAuthenticator) {
    const legacyAuthenticators = guardianEnrollments
      .filter((e) => e.status === 'confirmed' && e.type === 'authenticator')
      .map((e) => ({ ...e, source: 'guardian' as const }));
    result.push(...legacyAuthenticators);
  }

  return result;
}

/**
 * Delete every Guardian email enrollment for the user.
 *
 * Auth0 mirrors email factors created via the authentication-methods API into
 * Guardian. Deleting the authentication-method does NOT cascade to Guardian,
 * so the orphan keeps `event.user.enrolledFactors` populated and the
 * Post-Login Action keeps challenging with email. This sweep removes those
 * orphans so MFA truly turns off when email is removed.
 */
export async function deleteEmailGuardianEnrollments(sub: string): Promise<void> {
  const domain = getDomain();
  const token = await getManagementToken();
  const resp = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(sub)}/enrollments`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 list enrollments failed (${resp.status}): ${body}`);
  }

  const enrollments = (await resp.json()) as GuardianEnrollment[];
  const emailIds = enrollments.filter((e) => e.type === 'email').map((e) => e.id);

  await Promise.all(emailIds.map((id) => deleteGuardianEnrollment(id)));
}

/**
 * Delete a single Guardian enrollment by ID.
 */
export async function deleteGuardianEnrollment(enrollmentId: string): Promise<void> {
  const domain = getDomain();
  const token = await getManagementToken();
  const resp = await fetch(
    `https://${domain}/api/v2/guardian/enrollments/${encodeURIComponent(enrollmentId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 delete enrollment failed (${resp.status}): ${body}`);
  }
}

/**
 * Add email as an MFA factor via the Management API.
 * The Management API only allows adding email when the user has NO other
 * authentication methods. This makes email a low-friction first factor.
 * The factor is immediately confirmed — safe because the user's email
 * is already verified in our app. The Post-Login Action will see this
 * in event.user.enrolledFactors and challenge with a 6-digit email code.
 */
export async function enrollEmailMfa(sub: string, email: string): Promise<void> {
  const domain = getDomain();
  const token = await getManagementToken();
  const resp = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(sub)}/authentication-methods`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'email',
        name: 'Email',
        email,
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 enroll email MFA failed (${resp.status}): ${body}`);
  }
}

/**
 * Delete a single authentication method by ID (for email-type enrollments
 * which are stored as authentication-methods, not Guardian enrollments).
 */
export async function deleteAuthenticationMethod(sub: string, methodId: string): Promise<void> {
  const domain = getDomain();
  const token = await getManagementToken();
  const resp = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(sub)}/authentication-methods/${encodeURIComponent(methodId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 delete authentication method failed (${resp.status}): ${body}`);
  }
}

/**
 * Delete all MFA enrollments for a user (both Guardian and authentication-methods),
 * then clear the mfa_enrolling flag. The Post-Login Action will no longer challenge.
 *
 * Deletes are attempted in parallel via Promise.allSettled so a single failure
 * does not strand the user with a half-deleted set of factors. The
 * mfa_enrolling flag is only cleared when every delete succeeded — leaving it
 * set on partial failure keeps the Post-Login Action protective until the
 * caller retries.
 */
export async function deleteAllAuthenticators(sub: string): Promise<void> {
  const enrollments = await getMfaEnrollments(sub, { includeEmail: true });
  const hasEmail = enrollments.some((e) => e.type === 'email');

  const operations: Array<Promise<void>> = enrollments.map((enrollment) =>
    enrollment.source === 'guardian'
      ? deleteGuardianEnrollment(enrollment.id)
      : deleteAuthenticationMethod(sub, enrollment.id),
  );
  // Email factors are mirrored into Guardian and the auth-methods delete does
  // not cascade. Sweep any orphan Guardian email rows so the user is not
  // re-challenged with email after MFA is "removed".
  if (hasEmail) {
    operations.push(deleteEmailGuardianEnrollments(sub));
  }

  const results = await Promise.allSettled(operations);

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length > 0) {
    const reasons = failures.map((f) => String(f.reason)).join('; ');
    throw new Error(
      `Failed to delete ${failures.length} of ${operations.length} MFA factor(s): ${reasons}`,
    );
  }

  await updateAuth0User(sub, {
    app_metadata: { mfa_enrolling: false, email_mfa_active: false },
  });
}
