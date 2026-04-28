# ADR: Multi-Factor Authentication

**Status:** Accepted
**Created:** 2026-03-23
**Last updated:** 2026-03-24

## Context

The platform authenticates users via Auth0 with an authorization code flow, HTTP-only cookie sessions, and social login support (Google, GitHub) alongside native Auth0 username/password. Enterprise clients expect MFA as a security baseline, but the current Settings page shows a disabled "Enable" button with placeholder text. No MFA factors are configured in Auth0.

MFA must be opt-in per user (not org-enforced), must not require ongoing per-use costs, and must work for all connection types (database and social). The enrollment flow should reuse Auth0 Universal Login rather than building a custom enrollment UI.

## Options Considered

### MFA Factors

| Factor                            | Pros                                      | Cons                                                               |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| OTP (authenticator app)           | Free, no vendor dependency, works offline | User must install an app                                           |
| WebAuthn (passkeys/security keys) | Phishing-resistant, great UX              | Device/browser support varies                                      |
| Email (one-time code)             | No app install, low friction              | Weakest factor, less useful if email is the login method           |
| SMS                               | Familiar, no app install                  | Auth0 charges ~$0.008-0.05/message via Twilio, SIM-swap vulnerable |

SMS is excluded due to per-message cost and SIM-swap vulnerability. The remaining three factors cover the security spectrum: OTP for offline-capable security, WebAuthn for phishing resistance, and email for low-friction challenge (email cannot be used for enrollment, only challenge — Auth0 auto-enrolls it via Guardian).

### Enrollment Approach

**Custom enrollment UI** — Build our own TOTP secret display, QR code generation, and WebAuthn registration. Rejected because it duplicates what Auth0 Universal Login already provides and introduces security surface area.

**`acr_values` parameter** — Force a fresh login with `acr_values` requesting MFA. Rejected because Auth0 does not reliably pass `acr_values` to Post-Login Actions in all configurations.

**`app_metadata.mfa_enrolling` flag** — Backend sets a flag, the Post-Login Action reads it and triggers enrollment. The flag is a one-time signal, not a source of truth. Chosen because it reliably triggers enrollment through Auth0's Action system.

### MFA Status Source of Truth

Auth0 has two separate MFA systems:

- **Guardian** (older) — handles OTP, push, SMS, email. Enrollments live on the user object under `guardian_authenticators`. This is what Auth0 Actions use when calling `enrollWith()` / `challengeWith()`.
- **Authentication Methods** (newer) — unified API at `/api/v2/users/{id}/authentication-methods`. Does NOT reflect Guardian enrollments.

Since Actions enroll through Guardian, enrollment data only appears in `guardian_authenticators`. The `authentication-methods` endpoint is not usable for our purposes.

The current implementation reads `guardian_authenticators` from the user object via `GET /api/v2/users/{id}`, filtered to MFA types (excludes auto-enrolled email). This is only queried when `?include=mfa` is passed to `GET /api/me` (currently only the Settings page).

## Decision

Enable **OTP, WebAuthn, and Email** as MFA factors in Auth0. Set the MFA policy to **"Never"**. SMS is excluded. MFA is opt-in per user and available for all connection types (database and social).

The MFA policy is "Never" because enrollment and challenge are controlled entirely by a Post-Login Action. The Action uses `app_metadata.mfa_enrolling` as a one-time enrollment trigger and checks `enrolledFactors` to challenge enrolled users on every login.

The Action is created, deployed, and bound to the Login flow automatically by the `setup-integrations` deploy Lambda (staging/production only).

### Auth0 MFA Architecture

Auth0 Actions enroll users through the **Guardian** system. Key implications:

- Enrollments appear in `guardian_authenticators` on the user object, NOT in the `/authentication-methods` API
- `enrollWith()` only supports: `otp`, `webauthn-roaming`, `webauthn-platform`, `push`, `push-notification`, `recovery-code` — **email is not supported for enrollment**
- `challengeWith()` supports all the above plus `email`
- `enrollWithAny(factors)` takes an array of factor objects and shows a selection screen
- `challengeWithAny(factors)` takes an array and shows a selection screen
- `event.user.enrolledFactors` includes ALL factors (social, password, etc.) — must filter to MFA types

### Post-Login Action

```js
exports.onExecutePostLogin = async (event, api) => {
  const mfaFactors = (event.user.enrolledFactors || []).filter(
    (f) => f.type === 'otp' || f.type === 'webauthn-roaming' || f.type === 'recovery-code',
  );
  const hasMfa = mfaFactors.length > 0;
  const mfaEnrolling = event.user.app_metadata?.mfa_enrolling === true;

  if (mfaEnrolling && !hasMfa) {
    api.authentication.enrollWithAny([{ type: 'otp' }, { type: 'webauthn-roaming' }]);
  } else if (mfaEnrolling && hasMfa) {
    api.user.setAppMetadata('mfa_enrolling', false);
    api.authentication.challengeWithAny([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'email' },
    ]);
  } else if (hasMfa) {
    api.authentication.challengeWithAny([
      { type: 'otp' },
      { type: 'webauthn-roaming' },
      { type: 'email' },
    ]);
  }
};
```

### Enrollment Flow

1. User clicks "Enable" (or "Add another") on the Settings page
2. Frontend calls `POST /api/mfa/enroll` — backend validates user has no authenticators enrolled (or allows adding more), sets `app_metadata.mfa_enrolling: true`
3. Frontend redirects to Auth0 with `prompt=login` and `login_hint` (user's email)
4. The Post-Login Action detects `mfa_enrolling === true`, sees no MFA factors enrolled, and calls `enrollWithAny()` presenting OTP and WebAuthn as options
5. User enrolls; Auth0 Universal Login handles the entire enrollment UX
6. Subsequent logins: the Action detects enrolled MFA factors and calls `challengeWithAny()` with OTP, WebAuthn, and email as options

If the user abandons enrollment, the `mfa_enrolling` flag remains set. The next login re-triggers enrollment. Once enrolled, the Action detects existing factors and clears the flag.

### Disable Flow

**Remove individual enrollment:**

1. Settings page shows each enrolled factor with a "Remove" button
2. Frontend calls `DELETE /api/mfa/enrollments/{enrollmentId}`
3. Backend verifies the enrollment belongs to this user, deletes it via `DELETE /api/v2/guardian/enrollments/{id}`
4. If last enrollment removed, clears `mfa_enrolling` flag

**Remove all:**

1. User clicks "Remove all MFA methods" on Settings page
2. Frontend calls `POST /api/mfa/disable`
3. Backend deletes all MFA Guardian enrollments and clears the `mfa_enrolling` flag

### Social Login Users

Social login users (Google, GitHub) can enroll in Auth0 MFA. Auth0 is the session authority regardless of the upstream identity provider — after the social provider returns, Auth0 challenges with MFA before completing the login. The Settings page shows the same MFA UI for all users.

### Auth0 Dashboard Configuration Required

1. **Enable factors** (Security > Multi-factor Auth): OTP, WebAuthn with FIDO Security Keys, Email
2. **Set MFA policy to "Never"** — the Post-Login Action controls all MFA behavior
3. **Enable "Customize MFA Factors using Actions"** under additional settings
4. **Post-Login Action** — automated via `setup-integrations` deploy Lambda (staging/production)

### Management API Scopes

| Scope                         | Used by                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `read:users`                  | `getMfaEnrollments()` — reads `guardian_authenticators` from user object (already granted) |
| `update:users_app_metadata`   | `flagMfaEnrollment()` — sets `mfa_enrolling` flag (already granted)                        |
| `delete:guardian_enrollments` | `deleteGuardianEnrollment()` / `deleteAllAuthenticators()` — removes enrolled factors      |
| `create:actions`              | Deploy-time setup — creates the MFA Post-Login Action                                      |
| `read:actions`                | Deploy-time setup — checks if the Action already exists                                    |
| `update:actions`              | Deploy-time setup — updates the Action code if changed                                     |
| `read:triggers`               | Deploy-time setup — reads the Login flow bindings                                          |
| `update:triggers`             | Deploy-time setup — binds the Action to the Login flow                                     |

### Backend Changes

- **`auth0-management.ts`**: `getMfaEnrollments(sub)` reads `guardian_authenticators` from the user object, `flagMfaEnrollment(sub)` sets the enrollment flag, `deleteGuardianEnrollment(id)` removes a single enrollment, `deleteAllAuthenticators(sub)` removes all MFA enrollments and clears the flag
- **`enroll-mfa.ts`**: `POST /api/mfa/enroll` — checks not already enrolled, sets `mfa_enrolling` flag, returns 200 so frontend can redirect
- **`disable-mfa.ts`**: `POST /api/mfa/disable` — checks enrollments exist, deletes all MFA enrollments
- **`delete-mfa-enrollment.ts`**: `DELETE /api/mfa/enrollments/{enrollmentId}` — verifies enrollment belongs to user, deletes single enrollment, clears flag if last one
- **`get-me.ts`**: returns `mfaEnrollments` array (id, type, name, createdAt) when `?include=mfa` is passed
- **`MeResponse`** (shared types): added `MfaEnrollment` interface and `mfaEnrollments` array
- **`sst.config.ts`**: three MFA routes registered
- **`setup-integrations.ts`**: deploy-time Lambda creates, deploys (waits for build), and binds the Post-Login Action (staging/production only). Email provider setup is non-fatal.

### Frontend Changes

- **`api.ts`**: `enrollMfa(email?)` sets flag then redirects with `prompt=login` and `loginHint`; `disableMfa()` removes all; `deleteMfaEnrollment(id)` removes single enrollment
- **`SettingsPage.tsx`**: shows each enrolled factor with type, name, date, and individual "Remove" button; "Add another" button when MFA is already enabled; "Remove all MFA methods" link; calls `getMe({ include: 'mfa' })` only on this page

## Future Enhancements (Out of Scope)

- **Step-up auth** — require fresh MFA for sensitive actions (disable MFA, delete account)
- **Org-level MFA enforcement** — org setting `requireMfa: boolean` that forces all members to enroll
- **View recovery codes** — custom UI to regenerate/display recovery codes post-enrollment
- **Remember device** — Auth0 can skip MFA on trusted devices for 30 days

## Risks

### Auth0 Management API Rate Limits

`getMfaEnrollments()` fetches the full user object from the Management API when `GET /api/me?include=mfa` is requested (currently only the Settings page). Auth0's Management API rate limit is 50 requests/second for free/essentials plans. At current scale this is not a concern.

### Auth0 Guardian vs Authentication Methods

Auth0 has two MFA systems (Guardian and Authentication Methods) that do not share data. Actions enroll through Guardian, so enrollment data only appears in `guardian_authenticators`. If Auth0 migrates Actions to use Authentication Methods in the future, the `getMfaEnrollments()` function will need updating.

## Consequences

- MFA is opt-in per user. All connection types (database and social) can enroll.
- Auth0 Universal Login handles all enrollment and challenge UX — no custom MFA UI to maintain.
- `guardian_authenticators` on the user object is the source of truth for MFA status. A single `app_metadata.mfa_enrolling` flag is used as a one-time enrollment trigger. The Post-Login Action handles both enrollment and challenge.
- OTP and WebAuthn are available for enrollment; email is available for challenge only.
- Users can view, add, and individually remove MFA methods from the Settings page.
- Abandoned enrollment attempts leave `mfa_enrolling: true` — harmless, re-triggers on next login.
- The Post-Login Action is deployed automatically via the `setup-integrations` Lambda.
