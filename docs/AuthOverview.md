# Authentication and Authorization Overview

This document describes how authentication and authorization work in the Hyperspace console (fil.one). For background and trade-offs on MFA, see ADR at [`docs/architectural-decisions/2026-03-mfa-enrollment.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-03-mfa-enrollment.md). For passkeys as a primary authentication factor (phishing-resistant, satisfies MFA), see [`docs/architectural-decisions/2026-05-passkey-primary-authentication.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-05-passkey-primary-authentication.md).

## TL;DR

- **Identity provider:** Auth0 owns user pools, password storage, social/SSO connections, MFA challenges, and access/ID/refresh token issuance.
- **BFF:** The console API (Lambda + API Gateway) is the Backend-for-Frontend. It handles the OAuth2 authorization-code exchange and writes HTTP-only cookies. The SPA never touches tokens.(AI loves this BFF term: I never seen it before but makes enough sense to me)
- **Internal identity:** Each Auth0 `sub` is mapped 1:1 to an internal `userId` (UUID) and `orgId` (UUID) in DynamoDB on first login. The mapping is resolved in middleware on every request.
- **Tenancy:** Users map 1:1 with orgs today (one user creates one org as Admin; multi-member orgs are not yet enabled). Each confirmed org gets up to one Aurora tenant.
- **Authorization:** A subscription guard middleware reads the user's Stripe subscription state from DynamoDB and gates routes by `AccessLevel.Read` or `AccessLevel.Write`.
- **MFA:** Optional per user. OTP, WebAuthn, and biometric (fingerprint / Face ID) enrollment is driven by an Auth0 Post-Login Action and `app_metadata.mfa_enrolling`. Email is intentionally not offered as an MFA factor and we limit email's role to the sign-up verification gate (see Tenancy below).

## Request lifecycle

```
Browser                    Console API Lambda                    Auth0 / DynamoDB / Stripe
   |                              |                                       |
   | GET /login                   |                                       |
   |----------------------------->| auth-login.ts                         |
   |                              | build authorize URL, set state cookie |
   |<-----------------------------|                                       |
   | 302 to Auth0                                                         |
   |--------------------------------------------------------------------->|
   |                              |  Universal Login + optional MFA       |
   |<---------------------------------------------------------------------|
   | 302 /api/auth/callback?code=...                                      |
   |----------------------------->| auth-callback.ts                      |
   |                              | exchange code for tokens ------------>|
   |                              | set hs_access/id/refresh/csrf cookies |
   |<-----------------------------| 302 to /dashboard                     |
   |                              |                                       |
   | GET /api/buckets (cookies)   |                                       |
   |----------------------------->| middy stack:                          |
   |                              |   1. authMiddleware (verify JWT,      |
   |                              |      refresh if needed,               |
   |                              |      resolve sub→userId/orgId)        |
   |                              |   2. csrfMiddleware (mutations only)  |
   |                              |   3. subscriptionGuardMiddleware      |
   |                              |      (Read/Write × Stripe state)      |
   |                              |   4. handler (uses getUserInfo)       |
   |<-----------------------------| 200 + JSON (+ refreshed cookies)      |
```

## Code map (start here)

Background reading: [`docs/architectural-decisions/2026-03-mfa-enrollment.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-03-mfa-enrollment.md) (MFA enrollment ADR).

### Middleware (Middy)

| Area                                                       | File                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth middleware (JWT verify, refresh, identity resolution) | [`packages/backend/src/middleware/auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts)                             |
| CSRF middleware                                            | [`packages/backend/src/middleware/csrf.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/csrf.ts)                             |
| Subscription/authorization middleware                      | [`packages/backend/src/middleware/subscription-guard.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/subscription-guard.ts) |
| MFA step-up middleware (`requireFreshMfa`)                 | [`packages/backend/src/middleware/require-fresh-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/require-fresh-mfa.ts)   |

### Backend (handlers, lib, infra)

| Area                                                        | File                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login handler (state cookie + Auth0 redirect)               | [`packages/backend/src/handlers/auth-login.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/auth-login.ts)                                                                                                                                                                             |
| Callback handler (code → tokens → cookies)                  | [`packages/backend/src/handlers/auth-callback.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/auth-callback.ts)                                                                                                                                                                       |
| Logout handler                                              | [`packages/backend/src/handlers/auth-logout.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/auth-logout.ts)                                                                                                                                                                           |
| MFA: enrollment flag handler                                | [`packages/backend/src/handlers/enroll-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/enroll-mfa.ts)                                                                                                                                                                             |
| MFA: disable / delete enrollment                            | [`packages/backend/src/handlers/disable-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/disable-mfa.ts), [`packages/backend/src/handlers/delete-mfa-enrollment.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/delete-mfa-enrollment.ts) |
| MFA: Auth0 Post-Login Action source                         | [`packages/backend/src/jobs/stack-setup/mfa-action.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/jobs/stack-setup/mfa-action.ts)                                                                                                                                                             |
| Auth0 deploy-time setup (callbacks, Action, email provider) | [`packages/backend/src/jobs/stack-setup/setup-integrations.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/jobs/stack-setup/setup-integrations.ts)                                                                                                                                             |
| Stripe webhook                                              | [`packages/backend/src/handlers/stripe-webhook.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/stripe-webhook.ts)                                                                                                                                                                     |
| Auth0 Management API client                                 | [`packages/backend/src/lib/auth0-management.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth0-management.ts)                                                                                                                                                                           |
| Auth0 secrets accessor                                      | [`packages/backend/src/lib/auth-secrets.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth-secrets.ts)                                                                                                                                                                                   |
| Cookie/response helpers (names, max ages, attributes)       | [`packages/backend/src/lib/response-builder.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/response-builder.ts)                                                                                                                                                                           |
| Per-request user context                                    | [`packages/backend/src/lib/user-context.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/user-context.ts)                                                                                                                                                                                   |
| Auth0 authorize URL builder (shared)                        | [`packages/shared/src/auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/auth.ts)                                                                                                                                                                                                             |
| Infra: Auth0 secrets, routes, env wiring                    | [`sst.config.ts`](https://github.com/filecoin-project/fil-one/blob/main/sst.config.ts)                                                                                                                                                                                                                                         |

### Frontend (SPA — `packages/website`)

| Area                                                 | File                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SPA API wrapper (cookies, CSRF header, 401 handling) | [`packages/website/src/lib/api.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts)                             |
| SPA route guard (logged-in + email-verified checks)  | [`packages/website/src/routes/_app.tsx`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/routes/_app.tsx)                   |
| SPA sign-in entry                                    | [`packages/website/src/routes/_auth/sign-in.tsx`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/routes/_auth/sign-in.tsx) |

## Auth0 integration

### What Auth0 owns

- User pool (email/password, Google, GitHub, future SSO/SAML)
- OAuth2 authorization-code + PKCE flow on Universal Login
- Access token (RS256 JWT, `aud=https://app.fil.one` or `https://staging.fil.one`), ID token, refresh token issuance
- MFA enrollment and challenge UI (TOTP, WebAuthn, biometrics — fingerprint / Face ID)
- Email delivery (configured to use SendGrid in production — see [`docs/architectural-decisions/2026-03-sendgrid-auth0-email-provider.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-03-sendgrid-auth0-email-provider.md))

### Credentials and M2M apps

Three Auth0 applications back the integration. All credentials are SST secrets, never in source or env files. Loaded via [`packages/backend/src/lib/auth-secrets.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth-secrets.ts).

| App                                 | Secrets                                                    | Used by                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console SPA / BFF (regular web app) | `Auth0ClientId`, `Auth0ClientSecret`                       | OAuth code exchange in [`auth-callback.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/auth-callback.ts) and refresh in [`auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts) |
| Deploy-time M2M                     | `Auth0MgmtClientId`, `Auth0MgmtClientSecret`               | One-shot setup job that configures callbacks, deploys the Post-Login Action, and configures the email provider                                                                                                                                                              |
| Runtime M2M                         | `Auth0MgmtRuntimeClientId`, `Auth0MgmtRuntimeClientSecret` | Per-request user-management calls (MFA list/delete, profile update, account deletion) from [`auth0-management.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth0-management.ts)                                                      |

The two-M2M split is intentional: the deploy-time app holds powerful scopes (`update:clients`, `update:triggers`, etc.) that no runtime handler should ever need. See the ADR for the per-scope table.

### JWKS and token verification

- `createRemoteJWKSet(https://${AUTH0_DOMAIN}/.well-known/jwks.json)` is cached at module scope so warm Lambdas do not refetch ([`auth.ts:54-60`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts#L54-L60)).
- Access tokens are verified with `jwtVerify(token, jwks, { audience, issuer })`.
- ID tokens are verified separately to extract `email`, `email_verified`, `name`, `picture` ([`auth.ts:158-182`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts#L158-L182)). Failure is non-fatal — the user is still authenticated, just without profile claims.

## Cookies and session

All session state lives in cookies set by the Lambda BFF. Definitions in [`response-builder.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/response-builder.ts).

| Cookie             | HttpOnly | Max age | Purpose                                                                                 |
| ------------------ | -------- | ------- | --------------------------------------------------------------------------------------- |
| `hs_access_token`  | yes      | 1 hour  | JWT access token, verified per request                                                  |
| `hs_id_token`      | yes      | 1 hour  | OIDC ID token, source of `email`/`email_verified`/profile                               |
| `hs_refresh_token` | yes      | 30 days | Silent refresh grant                                                                    |
| `hs_logged_in`     | no       | 30 days | JS-readable hint so the SPA can short-circuit "are we logged in" without a network call |
| `hs_csrf_token`    | no       | 1 hour  | JS-readable double-submit token, rotated on each refresh                                |
| `hs_oauth_state`   | yes      | short   | OAuth state for the in-flight authorize request                                         |

All cookies use `Secure; SameSite=Lax; Path=/`. `Lax` (not `Strict`) is required so cookies survive the Auth0 → `/api/auth/callback` redirect.

There is no `Authorization: Bearer` path. Cookie-only so JS cannot access the sensitive user tokens.

Hs stands for "hyperspace", the original codename.

## Middleware chain

Every authenticated handler composes Middy middleware in this order:

```ts
export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware()) // identity + token refresh
  .use(requireFreshMfa({ maxAgeSeconds: 300 })) // optional, for sensitive MFA/account routes — see MFA § Step-up
  .use(csrfMiddleware()) // mutations only
  .use(subscriptionGuardMiddleware(AccessLevel.X)) // optional, for billing-gated routes
  .use(errorHandlerMiddleware());
```

Examples: [`list-buckets.ts:81-86`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/list-buckets.ts#L81-L86), [`create-bucket.ts:111`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/create-bucket.ts#L111), [`get-me.ts:76`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/get-me.ts#L76) (note: `/api/me` skips the subscription guard).

### authMiddleware ([`auth.ts:345-493`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts#L345-L493))

`before` hook — three steps, fail-open within reason:

1. **Verify the access token.** If valid, extract `sub`, decode the ID token, attach identity, return.
2. **If invalid/expired, refresh.** POST to `/oauth/token` with `grant_type=refresh_token`. On success, stash new tokens in `request.internal.newTokens`, decode the fresh access token, attach identity. The `after` hook will write the refreshed cookies onto the response.
3. **Last-ditch fallback.** If the request had `?forceRefresh=1` (used after a profile update needs new claims) and the refresh failed, retry the original access token rather than 401-ing the user. Prevents transient Auth0 issues from logging everyone out -> unlikely in practice to happen.

If all three steps fail → 401.

`after` hook — if the handler called `requestTokenRefresh(event)` ([`user-context.ts:30`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/user-context.ts#L30)) or refresh tokens were minted earlier, write the cookies onto the response.

### Identity resolution: `sub` → `userId` + `orgId`

Implemented in `resolveUserAndOrg` ([`auth.ts:234-339`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts#L234-L339)) backed by DynamoDB `UserInfoTable`.

Look up `pk=SUB#${sub}, sk=IDENTITY`:

- **Hit:** read `userId`, `orgId`. Return.
- **Miss (first login):** atomic `TransactWriteItems` writes four records:
  - `SUB#${sub} / IDENTITY` (with `attribute_not_exists(pk)` to guard concurrent first logins)
  - `USER#${userId} / PROFILE`
  - `ORG#${orgId} / PROFILE` with `setupStatus: FILONE_ORG_CREATED`, suggested `name`
  - `ORG#${orgId} / MEMBER#${userId}` with `role: OrgRole.Admin`

The new user is now authenticated. Aurora tenant creation is _not_ triggered here — see Tenancy below.

### CSRF middleware ([`csrf.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/csrf.ts))

Double-submit token. On any non-safe method (anything other than GET/HEAD/OPTIONS), the `X-CSRF-Token` header must equal the `hs_csrf_token` cookie. The SPA reads the cookie and attaches the header in [`api.ts:40-43`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts#L40-L43). The token rotates on every token refresh.

## Tenancy and the user↔org model

Today, "1:1" describes the practical state, not a schema constraint:

- One Auth0 user → one internal `userId` → one `orgId` they created as Admin.
- The schema (`ORG#${orgId} / MEMBER#${userId}` rows) supports multiple members per org, but no invite/join flow exists yet. The DDB layout already accommodates multi-member growth without migration.
- No code path lets a user belong to more than one org. The `SUB#${sub} / IDENTITY` record holds a single `orgId`.

So this is entirely expandable to multiple users in one org and we can attach different rights/access scopes to them, if desired. I suggest to think through the product requirements on multiple user support, what kind of authorization model to use, and how we want to link accounts or invite users before modifying this. Auth0 has ability to invite users and we can use their organization construct.

### Roles

`OrgRole.Admin` is the only role assigned today (creator-as-admin). Auth0 RBAC is wired in the auth middleware design but not enforced in production — see the "RBAC (Planned)" section of the auth ADR. We do not need to use RBAC and can instead use resource based authZ which is also supported by Auth0 as an alternative and we have some notion of already between CSRF token enforcement and the stripe middleware guard.

For user management in the console, using Roles over resource based Auth0 claims would be easier to implement and simpler for customer. Ultimately use of the S3 Layer is driven through key/credential Sigv4 with IAM style permissions which is the more important AuthZ need. But this means we need to define all the roles necessary and document the permission model vs enabling any sort of fine-grain control over resources. Product should decide on which type of access control is needed and how organizations will work.

## Authorization: subscription-state gating

Authorization beyond "are you logged in" is driven by Stripe state. Implemented in [`subscription-guard.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/subscription-guard.ts).

### AccessLevel

Two levels, applied per route:

```ts
enum AccessLevel {
  Read = 'read',
  Write = 'write',
}
```

Could expand on this concept as a way to do more AuthZ based on Auth0 claims or roles that we configure.

### Subscription state machine

States are held on the user's billing record (`BillingTable`, key `CUSTOMER#${userId} / SUBSCRIPTION`) and updated by the Stripe webhook ([`stripe-webhook.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/stripe-webhook.ts)). The middleware also performs _lazy_ transitions on read.

| Stripe state                      | Read                            | Write                                | Notes                                                         |
| --------------------------------- | ------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| (no billing record)               | allow                           | allow                                | Background `createBillingTrial` enqueued in `after` hook      |
| (record, no `subscriptionStatus`) | allow                           | allow                                | Pre-trial setup window                                        |
| `Active`                          | allow                           | allow                                |                                                               |
| `Trialing`                        | allow\*                         | allow\*                              | If `trialEndsAt < now`, lazily transition to `GracePeriod`    |
| `GracePeriod`                     | allow                           | **403 `GRACE_PERIOD_WRITE_BLOCKED`** | If `gracePeriodEndsAt < now`, lazily transition to `Canceled` |
| `PastDue`                         | allow                           | **403 `GRACE_PERIOD_WRITE_BLOCKED`** | Same write-block as grace period                              |
| `Canceled`                        | **403 `SUBSCRIPTION_CANCELED`** | **403 `SUBSCRIPTION_CANCELED`**      |                                                               |
| Unknown / unhandled               | **403 `SUBSCRIPTION_INACTIVE`** | **403 `SUBSCRIPTION_INACTIVE`**      | Fail closed                                                   |

Grace-period durations live in [`packages/shared/src/constants.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/constants.ts) (`TRIAL_GRACE_DAYS`, `PAID_GRACE_DAYS`).

The middleware also stashes the resolved `subscriptionStatus` on `event.requestContext.subscriptionStatus` so handlers can branch on it without a second DDB read.

### Where it's applied

Search: `grep -rn "subscriptionGuardMiddleware" packages/backend/src/handlers`. Today:

- **Read-gated:** `list-buckets`, `get-bucket`, `get-bucket-analytics`, `list-access-keys`, `presign`
- **Write-gated:** `create-bucket`, `delete-bucket`, `create-access-key`, `delete-access-key`

Notably _not_ gated: `/api/me`, `/api/me/resend-verification`, anything under `/api/auth/*`, `/api/mfa/*`, `/api/billing/*`, `stripe-webhook` (signature-verified, no auth middleware at all).

### Stripe webhook

[`stripe-webhook.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/stripe-webhook.ts) has no auth middleware. It verifies the signature with `stripe.webhooks.constructEvent`, claims the event ID via a conditional DDB write for idempotency, then updates `BillingTable` based on the Stripe event. Webhook secret is in SSM.

## Frontend

The SPA (React + TanStack Router, `packages/website`) is the only client. It does not store tokens — it relies on the cookies set by the BFF. Simple & secure.

### Login / logout

[`packages/website/src/lib/api.ts:18-22`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts#L18-L22) — `redirectToLogin()` is a `window.location.href = ${API_URL}/login` redirect. Logout works the same way against `/logout`. There is no SPA-side OAuth code; all of it happens in the Lambda BFF.

### Route guarding

[`packages/website/src/routes/_app.tsx`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/routes/_app.tsx) protects the authenticated app shell:

1. If the JS-readable `hs_logged_in` cookie is missing → redirect to `/login` (no round-trip).
2. Otherwise prefetch `/api/me` (cached via TanStack Query in [`query-client.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/query-client.ts)).
3. If `emailVerified=false` → `/verify-email`.
4. Render the app.

### API calls

The fetch wrapper at [`api.ts:34-93`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts#L34-L93) does three relevant things:

- `credentials: 'include'` so cookies are sent.
- For mutations, reads `hs_csrf_token` from `document.cookie` and attaches `X-CSRF-Token`.
- On 401, calls `redirectToLogin()`.

## MFA

Designed in [`docs/architectural-decisions/2026-03-mfa-enrollment.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-03-mfa-enrollment.md).

Email is intentionally **not** offered as an MFA factor — it is weaker than OTP / WebAuthn / biometrics (an attacker who has compromised an email account would also bypass MFA). Email's only role in auth is the sign-up verification gate (the `/verify-email` flow above).

### Enrollment — TOTP / WebAuthn / biometrics (in Universal Login)

1. `POST /api/mfa/enroll` calls `flagMfaEnrollment(sub)` which sets `app_metadata.mfa_enrolling=true` ([`auth0-management.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth0-management.ts)).
2. SPA redirects user back through `/login` with `prompt=login`.
3. The Auth0 Post-Login Action ([`mfa-action.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/jobs/stack-setup/mfa-action.ts), deployed at stack-setup time) reads the flag and calls `api.authentication.enrollWithAny([...])` to drive Auth0's enrollment UI (TOTP authenticator app, WebAuthn security keys, platform biometrics — fingerprint / Face ID).
4. On successful enrollment, the Action clears the flag.

### Removal

- `DELETE /api/mfa/enrollments/:id` — single factor.
- `POST /api/mfa/disable` — clears all factors and the `mfa_enrolling` flag in one shot ([`disable-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/disable-mfa.ts)).

The Management API client distinguishes between Guardian enrollments (`/api/v2/guardian/enrollments/...` for OTP/WebAuthn) and authentication methods (`/api/v2/users/{sub}/authentication-methods/...` for biometric and other modern factors). See [`auth0-management.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth0-management.ts).

### Recovery codes

Today: App surfaces a Step-up Auth protected endpoint to generate recovery code. The `mfaRecoveryCodes` branch is the in-flight work to expose recovery code regeneration in the SPA.

### Step-up authorizer (in flight on `mfaRecoveryCodes`)

A recovery code is a portable, take-anywhere bypass — a stolen session must not be enough to mint one. The `mfaRecoveryCodes` branch introduces a step-up auth pattern that will protect that endpoint and is meant to be reused across other sensitive MFA/account endpoints. Shape:

- **Backend:** new `requireFreshMfa({ maxAgeSeconds: 300 })` middy middleware (`packages/backend/src/middleware/require-fresh-mfa.ts`). Slots between `authMiddleware` and `csrfMiddleware`. Reads `auth_time` from the access token claims already verified by `authMiddleware` and returns `401 { error: 'step_up_required', maxAge: 300 }` if missing or stale.
- **Token claim:** `auth_time` is injected into the access token by the existing Post-Login Action via `api.accessToken.setCustomClaim('auth_time', ...)` ([`mfa-action.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/jobs/stack-setup/mfa-action.ts)) — sourced from the most recent `event.authentication.methods[].timestamp`. Updating the Action requires bumping the stack-setup function version (a plain string defined in SST — not tied to a version format) so it actually redeploys to Auth0. The same setup function configures more than the Action, so any change it deploys (Action source, callbacks, email provider, etc.) needs a bump.
- **Frontend:** the `apiRequest` wrapper ([`packages/website/src/lib/api.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts)) catches the `step_up_required` 401 and redirects to Auth0 `/authorize` with `prompt=login&max_age=300` and a `returnTo` carrying enough state (`?action=...`) for the page to resume the mutation after the round trip.
- **Freshness window:** 300s (matches Stripe / AWS console). Configurable per endpoint.
- **First consumer:** `POST /api/mfa/recovery-code/regenerate`. Planned follow-ups (mechanical, separate PRs): `/api/mfa/disable`, `DELETE /api/mfa/enrollments/{id}`, account deletion, password change.

Engineers adding a new sensitive endpoint should reach for `requireFreshMfa` rather than rolling their own freshness check. For instance, account deletion might want a forced login prior to allowing.

### MFA in `/api/me`

`/api/me?include=mfa` calls the Management API to list current enrollments. Without the flag, the handler skips that call to avoid a per-request M2M token roundtrip ([`get-me.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/get-me.ts)). There are cost implications to overusing the API, hence why we specifically are requesting that info from the client only when necessary.

The handler additionally short-circuits the passkey-list call for non-database connections (`google-oauth2`, etc.) since passkeys are only configured on `Username-Password-Authentication`. The trade-off is documented in the passkey ADR: enabling Auth0 account linking later would require revisiting this gate.

## Passkeys as a primary factor

Designed in [`docs/architectural-decisions/2026-05-passkey-primary-authentication.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-05-passkey-primary-authentication.md).

Passkeys on the `Username-Password-Authentication` connection are a phishing-resistant primary factor (distinct from the `webauthn-platform` / `webauthn-roaming` factors used for MFA). When a user signs in with a passkey, the Post-Login Action returns early — passkey login satisfies MFA via the `phr` AMR signal. New passkeys are enrolled by Auth0 Universal Login's Progressive Enrollment (no SPA enrollment UI). The Settings page surfaces enrolled passkeys via `GET /api/me?include=mfa`; individual deletes are gated by `requireMfa` step-up.

## Per-request user context

The auth middleware attaches a `UserInfo` object to `event.requestContext.userInfo` ([`user-context.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/user-context.ts)):

```ts
interface UserInfo {
  sub: string; // Auth0 subject — never persisted in app rows
  userId: string; // Internal UUID — primary handle in app code
  orgId: string; // Internal UUID
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}
```

Handlers read it via `getUserInfo(event)`. If a handler mutates Auth0 user data and needs the response cookies to carry fresh ID-token claims (e.g., name change), it calls `requestTokenRefresh(event)` and the auth middleware's `after` hook performs a refresh before writing cookies.

## Where to look next when extending this

- **Adding a new authenticated route:** copy the middy chain from [`list-buckets.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/list-buckets.ts) (read) or [`create-bucket.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/create-bucket.ts) (write). Register it in [`sst.config.ts`](https://github.com/filecoin-project/fil-one/blob/main/sst.config.ts) and pass the env vars through.
- **Adding a sensitive MFA / account route:** add `requireFreshMfa({ maxAgeSeconds: 300 })` ([`packages/backend/src/middleware/require-fresh-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/require-fresh-mfa.ts)) between `authMiddleware` and `csrfMiddleware`. Don't roll your own freshness check. See MFA § Step-up authorizer.
- **Adding a new social/SSO connection:** Auth0 dashboard only — no code change. The authorize URL builder ([`packages/shared/src/auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/auth.ts)) already accepts a `connection` hint.
- **Adding a Management API call:** add the function in [`auth0-management.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth0-management.ts) and grant the scope on the runtime M2M app in the Auth0 dashboard. Document the new scope in the auth ADR's runtime M2M scope table.
- **Tightening authorization:** today the only access discriminator beyond "logged in" is the Stripe state. Adding role/permission checks means activating Auth0 RBAC and threading `requiredPermissions` through `authMiddleware()` (see ADR §"RBAC (Planned)").
- **Multi-org / org membership:** the DDB layout (`ORG#${orgId} / MEMBER#${userId}`) already supports it, but the `SUB#${sub} / IDENTITY` record currently holds one `orgId`. Adding multi-org would require an org-switcher and an `orgId` claim on each request (cookie or header).

Claude code does a great job in doing this given how consistent we apply the pattern, but make sure to double check the endpoints are correctly configured during review!

## Open considerations for cross-service work

This document exists to support the conversation about extending auth/identity to additional services. Things worth pinning down before that:

- **Trust boundary between services.** Today the BFF is the only thing that holds Auth0 client credentials, talks to the Management API, and reads the user→org mapping. A second service can either (a) call the console API as the source of truth, or (b) verify Auth0 access tokens directly and look up its own `userId/orgId` mapping in `UserInfoTable`. Strong preference for the former since it means no other service needs to deal with our Auth0 instance. We should expose service to service authN/Z mechanism of some sort and define which APIs we want to support for this.
- **Token format for service-to-service.** Auth0 access tokens are issued for `aud=https://app.fil.one`. A separate audience per service (or a federated machine token) is cleaner than reusing the user token.
- **Where authorization decisions live.** All AuthZ decisions live in the backend. Frontend "reacts" to the data and http responses.
- **RBAC.** The roles table has one entry today and all users are admin. If we plan to share User Identity across services, agreeing on the role/permission model now avoids re-mapping later. Lots of product requirements needs on how we want to enable permissions with multi-user accounts. Strong preference to use Auth0 to manage organizations which can give access to more features like 3P SSO, potentially in the future and support email invite to orgs so a user gets a sign up link specific to the organization that already exists.
- **Service to Service AuthN/Z**. We have 2 kinds of operations we implicitly support: 1. User operations, 2. (S3) Service operations.
  - _User operations_ include things like billing changes, org name changes, viewing S3 usage dashboard, etc. This is the core Console API and these are all user interactions. These things could expand to service operations with a different AuthN/Z model if we are supporting external developer customers to programmatically do these things (very large amount of work).
  - _Service operations_ are S3 operations: PutObject, get object, head object (read metadata), etc. These directly call Aurora through presigned urls and have no need (or want) to go through our Console API layer. We have a secret Access Key we manage on their behalf and we can still do this while abiding by any User Permission model we decide on.
  - _Slightly ambiguous_ since these are only accessible to users right now, but should likely be considered service operations since they are supported by S3: things like Creating Aurora Buckets, Creating Aurora access keys, etc. Right now, we use special permissions with service to service auth with aurora for these operations since they are not supported in the S3 layer. I'd argue these are spiritually _Service operations_ and worth unifying with any permission model we expose with the other service operations in the same way AWS IAM does for S3 + other service. But as of today they are user operations.

So, in summary, Auth0 is the source of truth for user identity. Limited Authorization controls exist. For user authorization, need to define product requirements on how we want to enable management of authorization and how we want to enable multiple user/logins for the same tenant/organization. And for service operations we also need to define product requirements on what we need to support. We implicitly have another set of APIs for service level operations that is currently only gated by user specific authN/Z but should be expanded to support outside our console. And the service operations for S3 are supported through the sigv4 signed via console-managed access keys tied to a user/organization.
