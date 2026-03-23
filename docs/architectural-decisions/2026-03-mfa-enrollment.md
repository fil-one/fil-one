# ADR: Multi-Factor Authentication

**Status:** Accepted
**Created:** 2026-03-23

## Context

The platform authenticates users via Auth0 with an authorization code flow, HTTP-only cookie sessions, and social login support (Google, GitHub) alongside native Auth0 username/password. Enterprise clients expect MFA as a security baseline, but the current Settings page shows a disabled "Enable" button with placeholder text. No MFA factors are configured in Auth0.

MFA must be opt-in per user (not org-enforced), must not require ongoing per-use costs, and must not degrade the experience for social login users who already have MFA managed by their identity provider. The enrollment flow should reuse Auth0 Universal Login rather than building a custom enrollment UI.

## Options Considered

### MFA Factors

| Factor                            | Pros                                      | Cons                                                               |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| OTP (authenticator app)           | Free, no vendor dependency, works offline | User must install an app                                           |
| WebAuthn (passkeys/security keys) | Phishing-resistant, great UX              | Device/browser support varies                                      |
| Email (one-time code)             | No app install, low friction              | Weakest factor, less useful if email is the login method           |
| SMS                               | Familiar, no app install                  | Auth0 charges ~$0.008–0.05/message via Twilio, SIM-swap vulnerable |

SMS is excluded due to per-message cost (at 10k daily logins, ~$2,400/month before international rates) and SIM-swap vulnerability. The remaining three factors cover the security spectrum: OTP for offline-capable security, WebAuthn for phishing resistance, and email for low-friction onboarding.

### Enrollment Approach

**Custom enrollment UI** — Build our own TOTP secret display, QR code generation, and WebAuthn registration. Rejected because it duplicates what Auth0 Universal Login already provides, introduces security surface area around secret handling, and requires maintaining compatibility with authenticator apps.

**Auth0 Universal Login with `app_metadata` flags** — Set `mfa_enrolling: true` in `app_metadata` via the Management API, force a fresh login, and have a Post-Login Action detect the flag and route the user to enrollment. Rejected because it introduces state we have to manage (enrollment flags, cleanup on abandon) when Auth0 already tracks enrollment state natively via its authenticator records.

**Auth0 Universal Login with `acr_values`** — Force a fresh login with `prompt=login` and `acr_values` requesting MFA. Auth0 sees no enrolled authenticator and presents the enrollment screen natively. No backend state, no Actions, no flags. Auth0's "If supported" policy handles subsequent login challenges automatically based on whether the user has an enrolled authenticator.

### MFA Status Source of Truth

**`app_metadata` flags** — Store `mfa_enabled: boolean` in the user's `app_metadata` and read it via the Management API or custom token claims. Rejected because it duplicates state that Auth0 already maintains — whether the user has enrolled authenticators. The flag can diverge from reality (e.g., authenticator deletion fails but flag is cleared), creating ghost MFA states.

**Auth0 authenticator records** — Query `GET /api/v2/users/{id}/authentication-methods` to check if any active authenticators exist. This is the actual source of truth that Auth0's "If supported" policy uses to decide whether to challenge. No divergence possible.

The current implementation queries authenticator records via the Management API, but only when explicitly requested via `?include=mfa` on `GET /api/me`. This avoids adding latency to every page load — only the Settings page passes this parameter. At scale, this can migrate to a custom token claim injected by a Post-Login Action.

## Decision

Enable **OTP, WebAuthn, and Email** as MFA factors in Auth0. Set the MFA policy to **"If supported"**. SMS is excluded. MFA is opt-in per user and available for all connection types (database and social). Auth0's authenticator records are the sole source of truth — no `app_metadata` flags.

A minimal Post-Login Action is required to trigger enrollment. Auth0's "If supported" policy only _challenges_ users who already have an enrolled factor — it does not present enrollment to users without one. The Action reads `acr_values` from the transaction and calls `api.authentication.enrollWithAny()` when MFA is requested but no factor is enrolled.

### Enrollment Flow

1. User clicks "Enable" on the Settings page
2. Frontend calls `POST /api/mfa/enroll` — backend validates the user has no authenticators enrolled yet
3. Frontend redirects to Auth0 with `prompt=login` and `acr_values=http://schemas.openid.net/pape/policies/2007/06/multi-factor`
4. A Post-Login Action detects the `acr_values`, sees no enrolled factor, and calls `api.authentication.enrollWithAny()` to present the enrollment screen
5. User enrolls in OTP, WebAuthn, or Email; recovery codes are shown automatically
6. Subsequent logins: Auth0's "If supported" policy detects the enrolled authenticator and challenges automatically

If the user abandons enrollment (closes the tab), nothing changes — they have no authenticator enrolled, so future logins proceed without MFA. They can click "Enable" again to retry.

### Disable Flow

1. User clicks "Disable" on the Settings page
2. Frontend calls `POST /api/mfa/disable`
3. Backend confirms at least one authenticator is enrolled
4. Backend deletes all authenticators via `DELETE /api/v2/users/{id}/authentication-methods/{id}`
5. Next login: Auth0's "If supported" policy sees no authenticators, skips MFA

### Social Login Users

Social login users (Google, GitHub) can enroll in Auth0 MFA. Auth0 is the session authority regardless of the upstream identity provider — after the social provider returns, Auth0 can challenge with MFA before completing the login. The Settings page shows the same MFA enable/disable UI for all users.

### Auth0 Dashboard Configuration Required

1. **Enable factors** (Security > MFA): OTP, WebAuthn with FIDO Security Keys, Email
2. **Set MFA policy to "If supported"** — Auth0 challenges users who have enrolled authenticators, skips those who haven't
3. **Post-Login Action** (Actions > Flows > Login) — required to trigger enrollment:

```js
exports.onExecutePostLogin = async (event, api) => {
  const requestedMfa = event.transaction?.acr_values?.includes(
    'http://schemas.openid.net/pape/policies/2007/06/multi-factor',
  );
  if (!requestedMfa) return;

  const enrolled = event.user.enrolledFactors || [];
  if (enrolled.length === 0) {
    // Email is not supported for enrollment — only OTP and WebAuthn.
    // Once enrolled, users can challenge with email on subsequent logins.
    api.authentication.enrollWith([{ type: 'otp' }, { type: 'webauthn-roaming' }]);
  } else {
    api.authentication.challengeWith([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'email' },
    ]);
  }
};
```

This Action only activates when the frontend explicitly requests MFA via `acr_values` (the enrollment flow). Normal logins are handled by the "If supported" policy alone.

### Management API Scopes

| Scope                           | Used by                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `read:users`                    | `getMfaStatus()` — lists authenticators (already granted) |
| `read:authentication_methods`   | `getMfaStatus()` — reads authentication methods           |
| `delete:authentication_methods` | `deleteAllAuthenticators()` — removes enrolled factors    |

### Backend Changes

- **`auth0-management.ts`**: two new helpers — `getMfaStatus(sub)` checks for active authenticators, `deleteAllAuthenticators(sub)` removes all enrolled factors
- **`enroll-mfa.ts`**: `POST /api/mfa/enroll` — checks not already enrolled, returns 200 so frontend can redirect
- **`disable-mfa.ts`**: `POST /api/mfa/disable` — checks authenticators exist, deletes them
- **`get-me.ts`**: returns `mfaEnabled: boolean` in the response — defaults to `false`, only queries authenticator records when `?include=mfa` is present
- **`MeResponse`** (shared types): added `mfaEnabled: boolean`
- **`sst.config.ts`**: two new routes registered

### Frontend Changes

- **`api.ts`**: `enrollMfa()` calls the endpoint then redirects to Auth0 with `prompt=login` and `acr_values` requesting MFA; `disableMfa()` calls the disable endpoint; `buildAuth0LoginUrl()` now accepts `prompt` and `acrValues` options
- **`SettingsPage.tsx`**: MFA button is functional for all users (database and social) — shows "Enable" or "Disable" based on status, with loading states; calls `getMe({ include: 'mfa' })` to fetch MFA status only on this page

## Step-Up Auth (Planned)

Sensitive actions (disable MFA, delete account, change password) should require fresh authentication. Implementation:

- Check the `auth_time` claim in the ID token
- If older than 5 minutes, redirect to Auth0 with `prompt=login` and `acr_values=http://schemas.openid.net/pape/policies/2007/06/multi-factor`
- Backend validates `auth_time` on sensitive endpoints, returns 403 if stale

This is not yet implemented but is the next step.

## Future Enhancements (Out of Scope)

- **Org-level MFA enforcement** — org setting `requireMfa: boolean` that forces all members to enroll
- **View recovery codes** — custom UI to regenerate/display recovery codes post-enrollment
- **Remember device** — Auth0 can skip MFA on trusted devices for 30 days
- **Token-based MFA status** — migrate `mfaEnabled` from Management API authenticator checks to a custom token claim injected by a Post-Login Action, eliminating the per-request API call

## Risks

### Auth0 Management API Rate Limits

`getMfaStatus()` calls the Management API when `GET /api/me?include=mfa` is requested (currently only the Settings page). Auth0's Management API rate limit is 50 requests/second for free/essentials plans. At current scale this is not a concern, but at growth it could be if many users visit Settings simultaneously. Migrating to a custom token claim eliminates this call entirely.

## Consequences

- MFA is opt-in per user. All connection types (database and social) can enroll.
- Auth0 Universal Login handles all enrollment and challenge UX — no custom MFA UI to maintain.
- No `app_metadata` flags — Auth0's authenticator records are the single source of truth. A minimal Post-Login Action triggers enrollment when requested via `acr_values`; the "If supported" policy handles challenges on subsequent logins natively.
- Three MFA factors (OTP, WebAuthn, Email) are available at zero per-use cost.
- The disable flow removes authenticators entirely, allowing clean re-enrollment if MFA is re-enabled.
- Abandoned enrollment attempts leave no orphaned state — the user simply has no authenticator and can retry.
- Step-up auth for sensitive actions is designed but deferred.
