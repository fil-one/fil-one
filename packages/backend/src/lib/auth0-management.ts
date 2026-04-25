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

export interface GuardianEnrollment {
  id: string;
  type: string;
  status: string;
  name?: string;
  enrolled_at?: string;
}

// Guardian enrollment types that count as MFA (excludes auto-enrolled email)
export const MFA_GUARDIAN_TYPES = new Set([
  'authenticator',
  'webauthn-roaming',
  'webauthn-platform',
]);

// Types to include when listing for the UI (includes email)
const MFA_ALL_TYPES = new Set([...MFA_GUARDIAN_TYPES, 'email']);

/**
 * List MFA Guardian enrollments for a user.
 * Uses /api/v2/users/{id}/enrollments — the only endpoint that returns
 * Guardian-enrolled factors. The /authentication-methods endpoint does NOT
 * reflect Guardian enrollments, and guardian_authenticators is not returned
 * by the Management API (only visible in the Dashboard UI).
 *
 * By default filters to independent MFA types (OTP, WebAuthn).
 * Pass includeEmail: true to also return email enrollments for the UI.
 */
export async function getMfaEnrollments(
  sub: string,
  options?: { includeEmail?: boolean },
): Promise<GuardianEnrollment[]> {
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

  const types = options?.includeEmail ? MFA_ALL_TYPES : MFA_GUARDIAN_TYPES;
  const enrollments = (await resp.json()) as GuardianEnrollment[];
  return enrollments.filter((e) => e.status === 'confirmed' && types.has(e.type));
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
 */
export async function deleteAllAuthenticators(sub: string): Promise<void> {
  // Get all enrollments including email
  const enrollments = await getMfaEnrollments(sub, { includeEmail: true });
  const domain = getDomain();
  const token = await getManagementToken();

  for (const enrollment of enrollments) {
    if (enrollment.type === 'email') {
      // Email enrollments are authentication-methods, not Guardian enrollments
      await deleteAuthenticationMethod(sub, enrollment.id);
    } else {
      const delResp = await fetch(
        `https://${domain}/api/v2/guardian/enrollments/${encodeURIComponent(enrollment.id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!delResp.ok) {
        const body = await delResp.text();
        throw new Error(`Auth0 delete enrollment failed (${delResp.status}): ${body}`);
      }
    }
  }

  // Clear the enrolling flag
  await updateAuth0User(sub, {
    app_metadata: { mfa_enrolling: false },
  });
}
