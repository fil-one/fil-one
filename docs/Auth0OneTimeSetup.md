# Auth0 One-Time Setup

Auth0 powers authentication for fil.one. Most configuration is automated by the deploy-time setup Lambda (`setup-integrations`) on every staging/production deploy, but a handful of dashboard settings must be configured manually once per tenant before the first deploy. This document is the consolidated operator runbook for those one-time steps.

For the design rationale behind these choices, see:

- `docs/architectural-decisions/2026-03-mfa-enrollment.md` — MFA factor selection + Post-Login Action
- `docs/architectural-decisions/2026-05-passkey-primary-authentication.md` — passkeys as primary authentication

## Tenants

Two Auth0 tenants are used:

| Environment | Tenant        | Domain                              | Dashboard                                                                                                                      |
| ----------- | ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Staging/dev | **FilOneDev** | `dev-oar2nhqh58xf5pwf.us.auth0.com` | [Dashboard](https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ/settings) |
| Production  | **fil-one**   | `fil-one.us.auth0.com`              | [Dashboard](https://manage.auth0.com/dashboard/us/fil-one)                                                                     |

Auth0 credentials are managed as SST secrets (`Auth0ClientId`, `Auth0ClientSecret`). See the "Set SST secrets" step in the main `README.md`.

## Application

**Callback and logout URLs are configured automatically during deploy** — no manual Dashboard edits needed. The deploy-time setup Lambda adds the correct URLs for the deployed domain (custom domain or CloudFront).

**Application settings** (Applications > your app > Settings):

- Under **Advanced Settings > Grant Types**, ensure **Authorization Code** and **Refresh Token** are enabled.

**API setup** (APIs > Create API):

- **Identifier (audience)**: `app.fil.one` (prod) — this must match `AUTH0_AUDIENCE` in `sst.config.ts`. It's what makes Auth0 issue a JWT access token (instead of an opaque one) and is the `aud` claim the middleware validates.
- Under the API's **Machine to Machine Applications** tab, authorize your application so it can exchange tokens.

## MFA

MFA is opt-in per user (database and social connections). Auth0 handles enrollment and challenge via Universal Login. See `docs/architectural-decisions/2026-03-mfa-enrollment.md` for the full architectural decision record.

**1. Enable MFA factors** (Security > Multi-factor Auth) — manual, one-time per tenant:

- Enable **One-time Password** (authenticator apps)
- Enable **WebAuthn with FIDO Security Keys** (passkeys/security keys)
- Enable **WebAuthn with FIDO Device Biometrics** (fingerprint, Face ID)
- Do **not** enable **Email** or **SMS** — turning Email on tenant-wide causes Auth0 to auto-enroll every verified-email user into email MFA, defeating the strong-factor-only design
- Set policy to **"Never"** (MFA is controlled entirely by the Post-Login Action)
- Under additional settings, enable **"Customize MFA Factors using Actions"**

**2. Post-Login Action** — automated on deploy:

The deploy-time setup Lambda (`setup-integrations`) automatically creates, deploys, and binds an `MFA Enrollment Trigger` Action to the Login flow (staging/production only). This Action checks `app_metadata.mfa_enrolling` on each login — when `true`, it triggers MFA enrollment via Universal Login and clears the flag after success. No manual Action setup is needed.

## Passkeys

Passkeys are enabled as **primary authentication** on the `Username-Password-Authentication` connection — distinct from the WebAuthn factors above, which act as MFA. See `docs/architectural-decisions/2026-05-passkey-primary-authentication.md` for the full ADR.

**1. Tenant-wide settings** — manual, one-time per tenant. Auth0 surfaces a checklist if any of these are missing when the passkey toggle is flipped.

| #   | Setting                | Dashboard path                                                            | Required value                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Universal Login        | Branding > Universal Login                                                | **New** experience                                | Already on per existing setup; verify before enabling passkeys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | Identifier First Login | Authentication > Authentication Profile                                   | **Identifier First** (plain — not "+ Biometrics") | Two-step login (email → password/passkey). **Do not pick "Identifier First + Biometrics"** — that variant enables Auth0's legacy WebAuthn-platform-as-first-factor flow (`webauthn_platform_first_factor: true`), which the API treats as mutually exclusive with passkeys-on-connection and rejects the deploy-time PATCH with `"Passkey authentication is only compatible with Identifier First."`. The autofill-on-email-screen UX comes from `challenge_ui: "both"` on the connection and works under plain Identifier First. |
| 3   | Custom Login Page      | Branding > Universal Login > Advanced Options > Login                     | **Disabled**                                      | Default is disabled; confirm no custom HTML has been added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Custom domain          | Branding > Custom Domains                                                 | **Exactly one** (`auth.fil.one`)                  | Relying-party identifier — **changing it invalidates every enrolled passkey**.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | Connection database    | Authentication > Database > `Username-Password-Authentication` > Settings | **"Use my own database" off**                     | Already off; confirm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**2. Connection-level passkey settings** — automated on deploy:

The deploy-time setup Lambda (`setup-integrations`) PATCHes the `Username-Password-Authentication` connection on every staging/production deploy with `authentication_methods.passkey.enabled: true`, `passkey_options.progressive_enrollment_enabled: true`, `passkey_options.local_enrollment_enabled: true`, and `passkey_options.challenge_ui: "both"`. Password authentication stays enabled — Auth0 does not currently support disabling it. No manual dashboard toggling required after the prerequisites above are met.

**3. Required Management API scopes** — the deploy-time M2M app needs `read:connections`, `update:connections`, and `update:connections_options` in addition to the scopes listed under "Machine-to-Machine (M2M) Applications" below. The runtime M2M app uses `read:authentication_methods` and `delete:authentication_methods` (already granted for MFA) to list and delete passkeys.

**4. Operator runbook — relying-party domain changes:**

The custom domain (`auth.fil.one`) is the WebAuthn relying-party identifier baked into every enrolled passkey. **Any change to the custom domain invalidates every enrolled passkey across the tenant**, with no migration path. Treat domain changes as a forced re-enrollment event for every user, and coordinate accordingly. Cross-link: `docs/architectural-decisions/2026-05-passkey-primary-authentication.md`.

**5. Verification after first deploy:**

1. Sign up a new test user in the affected tenant.
2. When Universal Login prompts for a passkey during sign-up, enroll one.
3. Sign in with the new passkey and confirm no MFA challenge fires (a passkey login satisfies MFA via `performed_amr: ['phr']`).
4. Visit the settings page and confirm the passkey appears under the "Passkeys" row.

## Machine-to-Machine (M2M) Applications

Two separate M2M applications per tenant limit the blast radius of credentials. The deploy-time app is only available to the setup Lambda; the runtime app is available to request-time handlers.

### Deploy automation (`Auth0MgmtClientId` / `Auth0MgmtClientSecret`)

Used only by the deploy-time setup Lambda to configure Auth0 on each deploy. Not available to runtime Lambda functions.

| Environment | App name          | Dashboard                                                                                                                     |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Staging     | `SSTSetupM2MApp`  | [Settings](https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/WaVEvlq7iAirQa15CPPZJX0leTKWPJgw/settings) |
| Production  | Deploy Automation | [Settings](https://manage.auth0.com/dashboard/us/fil-one/applications/8t5J60CfojuktFBqppOseY8IzYQYYrcv/settings)              |

**Required scopes** (Applications > M2M app > APIs > Auth0 Management API):

`read:clients`, `update:clients`, `read:email_provider`, `create:email_provider`, `update:email_provider`, `create:actions`, `read:actions`, `update:actions`, `read:triggers`, `update:triggers`, `read:connections`, `update:connections`, `update:connections_options`

```bash
pnpx sst secret set Auth0MgmtClientId <M2M-client-id> [--stage <stage>]
pnpx sst secret set Auth0MgmtClientSecret <M2M-client-secret> [--stage <stage>]
```

### Runtime user management (`Auth0MgmtRuntimeClientId` / `Auth0MgmtRuntimeClientSecret`)

Used by request-time Lambda handlers (`update-profile`, `resend-verification`, `enroll-mfa`, `disable-mfa`, `delete-mfa-enrollment`, `delete-passkey`, `get-me`) to manage user records, trigger verification emails, and manage MFA enrollments and passkeys.

| Environment | App name    | Dashboard                                                                                                                     |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Staging     | Runtime M2M | [Settings](https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/CCONYSKqPecSTV8fxpfQJ7TLu6JseYSz/settings) |
| Production  | Runtime M2M | [Settings](https://manage.auth0.com/dashboard/us/fil-one/applications/1VydX3EOVZDHmVF3IdKa7n7pzRuczj7O/settings)              |

**Required scopes** (Applications > M2M app > APIs > Auth0 Management API):

`read:users`, `update:users`, `update:users_app_metadata`, `create:user_tickets`, `delete:users`, `delete:guardian_enrollments`, `read:authentication_methods`, `create:authentication_methods`, `delete:authentication_methods`

```bash
pnpx sst secret set Auth0MgmtRuntimeClientId <M2M-client-id> [--stage <stage>]
pnpx sst secret set Auth0MgmtRuntimeClientSecret <M2M-client-secret> [--stage <stage>]
```
