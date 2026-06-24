# ADR: Passkeys as Primary Authentication

**Status:** Accepted
**Created:** 2026-05-19
**Last updated:** 2026-06-16

## Context

The platform already supports two passkey shapes as **MFA factors** — `webauthn-platform` (device biometrics) and `webauthn-roaming` (security keys). Those are layered on top of a password as a second factor. See [2026-03-mfa-enrollment.md](./2026-03-mfa-enrollment.md).

This ADR covers passkeys as **primary authentication** on the database connection (`Username-Password-Authentication`): a passwordless sign-in where the user authenticates with a passkey alongside their existing password. Auth0 documents this at https://auth0.com/docs/authenticate/database-connections/passkeys.

Auth0 Universal Login owns the WebAuthn ceremonies. The work here is tenant configuration (one PATCH on the connection) plus a small change to the Post-Login Action so a passkey login isn't double-challenged for MFA.

## Options Considered

### Custom WebAuthn ceremonies in the SPA vs. Auth0 Universal Login

Auth0 Universal Login already implements the WebAuthn registration/assertion flow, including the discoverable-credential UX, browser autofill hints, and per-OS biometric prompts. Building our own would duplicate that work and add security surface. **Pick Universal Login.**

### Progressive Enrollment on by default vs. opt-in via settings link

Auth0's Progressive Enrollment prompts existing password-only users to add a passkey on their next Universal Login session. Without it we'd need an SPA-side "Add a passkey" CTA, which also requires re-authentication round-tripping through Universal Login. **Pick on-by-default** — no SPA changes needed.

## Decision

Enable passkeys on the `Username-Password-Authentication` connection with the following options, applied via `PATCH /api/v2/connections/{id}`:

```jsonc
{
  "options": {
    "authentication_methods": {
      "passkey": { "enabled": true },
      "password": { "enabled": true },
    },
    "passkey_options": {
      "progressive_enrollment_enabled": true,
      "local_enrollment_enabled": true,
      "challenge_ui": "both",
    },
  },
}
```

`progressive_enrollment_enabled: true` prompts existing password users to add a passkey on their next login. `local_enrollment_enabled: true` lets a user who authenticated via cross-device QR enroll a local passkey on the receiving device for subsequent logins. `challenge_ui: "both"` shows both a "Continue with a passkey" button and autofill on the email screen — matching the dashboard default.

The PATCH is applied by `setupAuth0PasskeyAuth` in `packages/backend/src/jobs/stack-setup/setup-passkey.ts`, called from the `setup-integrations` deploy Lambda on staging and production. Dev stacks share a tenant with staging and inherit whatever staging deployed last.

Passwords remain enabled alongside passkeys. Passkey login is additive — users can sign in with either factor.

### Post-Login Action: MFA skipped on passkey logins

A passkey is phishing-resistant and bound to user-verifying biometrics — the industry pattern (GitHub, Google, Microsoft) is to accept it as both factors. Inside the Post-Login Action, the only documented fields on `event.authentication.methods[]` are `name` and `timestamp` ([Auth0 Post-Login Event Object](https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger/post-login-event-object)), and `name: 'passkey'` is the documented value for a primary-passkey login on a database connection. The Post-Login Action returns early when that signal is present:

```ts
const usedPasskey = (event.authentication?.methods ?? []).some((m) => m.name === 'passkey');
if (usedPasskey && !mfaEnrolling) return;
```

The exception (`!mfaEnrolling`) covers the case where a passkey user clicked "Add MFA factor" or just redeemed a recovery code — in both cases the Action must fall through to the enrollment branch, otherwise the enroll button silently no-ops for passkey users.

The same "this login was phishing-resistant" signal shows up on three different surfaces, under three different names, and only one is reachable from inside the Action:

- **Action runtime** — `event.authentication.methods[]` exposes only `name` and `timestamp`. We match `name === 'passkey'`.
- **ID token** — the OIDC `amr` claim carries the _value_ `'phr'` for passkey logins. This is what request-time gating (`require-mfa` middleware) reads — `amr.includes('phr')`.
- **Tenant logs** — the per-method field is literally named `performed_amr` (value `phr`), under `details.authentication.methods[]`.

`phr` / `performed_amr` is the conceptually cleaner signal — it names the security property rather than the factor — but it is **not** on the Action event object, and the ID token isn't issued until after the Action runs. So the Action has no choice but to key off the factor name.

**Tradeoff:** matching `name === 'passkey'` is brittle. Auth0 owns that string and has used other values for WebAuthn factors historically (`webauthn`, etc.); a rename would silently break the MFA skip and double-challenge passkey users. `phr` would be immune to that, but it isn't available where the decision is made. We accept the brittleness and pin the expected value with a test (`mfa-action.test.ts`). The request-time gate and the Action must agree on what counts as phishing-resistant — otherwise a passkey user would skip the MFA challenge at login but get blocked from step-up-gated actions immediately after.

### Settings UI

The settings page surfaces a read-only "Passkeys" row when `?include=mfa` returns passkeys. Each passkey can be removed individually; the delete endpoint is gated by step-up auth (`requireMfa`) so a stolen short-lived session can't strip phishing-resistant factors. New enrollments are handled entirely by Auth0 Universal Login via Progressive Enrollment — no SPA enrollment button, no `prompt=login` plumbing.

### Read-path optimization: skip passkey fetch for non-database connections

`GET /api/me?include=mfa` short-circuits `getPasskeyAuthenticators` when the user's connection type isn't `auth0` (i.e., `google-oauth2`, `github`, etc.). The connection is derived from the `sub` prefix via `getConnectionType(sub)` — a pure string split, no extra Auth0 call. Passkeys are configured on the `Username-Password-Authentication` database connection only, so a social-login `sub` has no `type: 'passkey'` entries to return. The optimization saves one Management API roundtrip per Settings page load for every social-login user.

**Tradeoff:** if Auth0 account-linking ever attaches a database identity to a primary social-login user, the database identity's passkeys would not be surfaced through `/api/me`. We do not use account linking today and have no plans to enable it; if that changes, the short-circuit on `connectionType === 'auth0'` must be removed (or widened to include linked-identity inspection). The risk is contained: a user with passkeys can still authenticate with them — they just wouldn't appear in the Settings list.

### Operational constraints

- The relying-party identifier is the Auth0 custom domain (`auth.fil.one`). Every enrolled passkey is bound to that domain. **Any change to the custom domain invalidates every enrolled passkey across the tenant.** Treat domain changes as a forced re-enrollment event.
- A user with both a password and a TOTP factor will stop seeing the OTP challenge once they enroll a passkey and sign in with it. The passkey is strictly stronger; this is intended.
- Auth0 imposes a per-user cap of **20 passkeys**. Surface this in the settings UI so users hitting the cap know to remove one before adding another.
- Account recovery for a lost passkey falls back to password reset → re-enroll on next login (Progressive Enrollment handles the prompt). No new recovery flow.
- Auth0's Bot Detection runs pre-login as today; Captcha is skipped on passkey logins per Auth0's defaults. Accept this.

### Required Management API scopes

The deploy-time M2M app gains `read:connections` and `update:connections`. The runtime M2M app already has `read:authentication_methods` and `delete:authentication_methods` (used by MFA today) — passkeys live in the same listing endpoint and require the same scopes.

## Out of Scope

- **Native iOS/Android passkey integration** — we're web-only.
- **Custom WebAuthn ceremonies in the SPA** — Universal Login owns this.
- **Cross-device passkey sync** — platform concern (iCloud Keychain, Google Password Manager).
- **Re-enrollment flow when a user moves to a new device** — Progressive Enrollment on the next login covers it.
- **Step-up auth on passkey deletion** — already wired via `requireMfa` on the delete endpoint. The broader step-up roadmap is tracked in the MFA ADR.

## References

- ADR: `2026-03-mfa-enrollment.md` (MFA factor selection + Post-Login Action)
- Auth0 docs: https://auth0.com/docs/authenticate/database-connections/passkeys
- Auth0 Management API: `PATCH /api/v2/connections/{id}` — `options.authentication_methods.passkey`, `options.passkey_options`
- `Auth0OneTimeSetup.md` — operator runbook for tenant prerequisites
