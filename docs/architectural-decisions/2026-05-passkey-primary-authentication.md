# ADR: Passkeys as Primary Authentication

**Status:** Proposed
**Created:** 2026-05-19
**Last updated:** 2026-05-19

## Context

The platform already supports two passkey shapes as **MFA factors** — `webauthn-platform` (device biometrics) and `webauthn-roaming` (security keys). Those are layered on top of a password as a second factor. See `2026-03-mfa-enrollment.md`.

This ADR covers passkeys as **primary authentication** on the database connection (`Username-Password-Authentication`): a passwordless sign-in/sign-up where the user authenticates with a passkey instead of (or alongside) a password. Auth0 documents this at https://auth0.com/docs/authenticate/database-connections/passkeys.

Auth0 Universal Login owns the WebAuthn ceremonies. The work here is tenant configuration (one PATCH on the connection) plus a small change to the Post-Login Action so a passkey login isn't double-challenged for MFA.

## Options Considered

### Custom WebAuthn ceremonies in the SPA vs. Auth0 Universal Login

Auth0 Universal Login already implements the WebAuthn registration/assertion flow, including the discoverable-credential UX, browser autofill hints, and per-OS biometric prompts. Building our own would duplicate that work and add security surface. **Pick Universal Login.**

### Append to existing ADRs vs. dedicated ADR

`2026-03-authentication.md` covers the password+OAuth baseline; `2026-03-mfa-enrollment.md` covers MFA factor selection. Passkey-as-primary is a distinct decision from both — different threat model, different Auth0 surface, different operational constraints (e.g., relying-party domain). Co-locating would conflate three things that need to be reasoned about separately. **Pick a dedicated ADR; cross-link from the other two.**

### Force passkey-only vs. additive with password fallback

Auth0 does not currently support disabling password authentication on a database connection. Passkey-only is not reachable today. **Pick additive with password fallback**, with a note to revisit when Auth0 ships the toggle.

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

Passwords stay enabled because Auth0 does not yet support disabling password auth on a database connection. The desired end state is passkey-only with password recovery as a fallback channel; record that here so we can flip the toggle when it ships.

### Post-Login Action: MFA skipped on passkey logins

A passkey is phishing-resistant and bound to user-verifying biometrics — the industry pattern (GitHub, Google, Microsoft) is to accept it as both factors. Auth0's stable signal for this is `event.authentication.methods[].performed_amr` containing `'phr'` (phishing-resistant). The Post-Login Action returns early when that signal is present:

```ts
const usedPasskey = (event.authentication?.methods ?? []).some((m) =>
  (m.performed_amr ?? []).includes('phr'),
);
if (usedPasskey) return;
```

Matching on `performed_amr` (not on `m.name === 'passkey'`) is intentional — Auth0 has historically shifted the method-name strings (`passkey`, `webauthn`, `webauthn-platform`), but the AMR claim is the stable contract and the same signal that surfaces in tenant logs (`details.performed_amr`).

### Settings UI

The settings page surfaces a read-only "Passkeys" row when `?include=mfa` returns passkeys. Each passkey can be removed individually; the delete endpoint is gated by step-up auth (`requireMfa`) so a stolen short-lived session can't strip phishing-resistant factors. New enrollments are handled entirely by Auth0 Universal Login via Progressive Enrollment — no SPA enrollment button, no `prompt=login` plumbing.

### Operational constraints

- The relying-party identifier is the Auth0 custom domain (`auth.fil.one`). Every enrolled passkey is bound to that domain. **Any change to the custom domain invalidates every enrolled passkey across the tenant.** Treat domain changes as a forced re-enrollment event.
- A user with both a password and a TOTP factor will stop seeing the OTP challenge once they enroll a passkey and sign in with it. The passkey is strictly stronger; this is intended.
- Auth0 imposes a per-user cap of **20 passkeys**. Surface this in the settings UI so users hitting the cap know to remove one before adding another.
- Account recovery for a lost passkey falls back to password reset → re-enroll on next login (Progressive Enrollment handles the prompt). No new recovery flow.
- Auth0's Bot Detection runs pre-login as today; Captcha is skipped on passkey logins per Auth0's defaults. Accept this.

### Required Management API scopes

The deploy-time M2M app gains `read:connections` and `update:connections`. The runtime M2M app already has `read:authentication_methods` and `delete:authentication_methods` (used by MFA today) — passkeys live in the same listing endpoint and require the same scopes.

## Out of Scope

- **Forcing passkey-only signups** — not supported by Auth0 today. Revisit when the password-disable toggle ships.
- **Native iOS/Android passkey integration** — we're web-only.
- **Custom WebAuthn ceremonies in the SPA** — Universal Login owns this.
- **Cross-device passkey sync** — platform concern (iCloud Keychain, Google Password Manager).
- **Re-enrollment flow when a user moves to a new device** — Progressive Enrollment on the next login covers it.
- **Step-up auth on passkey deletion** — Stage B already wires `requireMfa` on the delete endpoint. The broader step-up roadmap is tracked in the MFA ADR.

## References

- ADR: `2026-03-authentication.md` (baseline auth + Universal Login + cookie session)
- ADR: `2026-03-mfa-enrollment.md` (MFA factor selection + Post-Login Action)
- Auth0 docs: https://auth0.com/docs/authenticate/database-connections/passkeys
- Auth0 Management API: `PATCH /api/v2/connections/{id}` — `options.authentication_methods.passkey`, `options.passkey_options`
- README: `### Auth0 Passkey Setup` (operator runbook)
