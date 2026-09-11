# Authentication and Authorization Overview

This document describes how authentication and authorization work in the Hyperspace console (fil.one). For background and trade-offs on MFA, see ADR at [`docs/architectural-decisions/2026-03-mfa-enrollment.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-03-mfa-enrollment.md). For passkeys as a primary authentication factor (phishing-resistant, satisfies MFA), see [`docs/architectural-decisions/2026-05-passkey-primary-authentication.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-05-passkey-primary-authentication.md).

## TL;DR

- **Identity provider:** Auth0 owns user pools, password storage, social/SSO connections, MFA challenges, and access/ID/refresh token issuance.
- **BFF:** The console API (Lambda + API Gateway) is the Backend-for-Frontend. It handles the OAuth2 authorization-code exchange and writes HTTP-only cookies. The SPA never touches tokens.(AI loves this BFF term: I never seen it before but makes enough sense to me)
- **Internal identity:** Each Auth0 `sub` is mapped to an internal `userId` (UUID) in DynamoDB on first login, along with the org that login created. The mapping is resolved in middleware on every request.
- **Tenancy:** A user can belong to several organizations. Membership is a row in `OrgTable`, the active org for a request comes from the `X-Org-Id` header, and each confirmed org gets up to one Aurora tenant.
- **Authorization:** Two independent gates, in this order. The caller's role in the active org carries a permission set, and `authorize(permission)` refuses a route the role does not reach. Then the subscription guard reads the org's Stripe state and gates by `AccessLevel.Read` or `AccessLevel.Write`. A non-member gets an authorization error rather than a billing one.
- **MFA:** Optional per user. OTP, WebAuthn, and biometric (fingerprint / Face ID) enrollment is driven by an Auth0 Post-Login Action and `app_metadata.mfa_enrolling`. Email is intentionally not offered as an MFA factor and we limit email's role to the sign-up verification gate (see MFA below).

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
   | GET /api/buckets             |                                       |
   | (cookies + X-Org-Id)         |                                       |
   |----------------------------->| middy stack:                          |
   |                              |   1. authMiddleware (verify JWT,      |
   |                              |      refresh if needed,               |
   |                              |      resolve sub→userId, resolve the  |
   |                              |      active org, read its membership) |
   |                              |   2. authorize(permission)            |
   |                              |      (the role's permission set)      |
   |                              |   3. csrfMiddleware (mutations only)  |
   |                              |   4. subscriptionGuardMiddleware      |
   |                              |      (Read/Write × Stripe state)      |
   |                              |   5. handler (uses getUserInfo)       |
   |<-----------------------------| 200 + JSON (+ refreshed cookies)      |
```

## Code map (start here)

Background reading: [`docs/architectural-decisions/2026-03-mfa-enrollment.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-03-mfa-enrollment.md) (MFA enrollment ADR).

### Middleware (Middy)

| Area                                                          | File                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth middleware (JWT verify, refresh, identity resolution)    | [`packages/backend/src/middleware/auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts)                                                                                                                               |
| Permission enforcement (`authorize`)                          | [`packages/backend/src/middleware/authorize.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/authorize.ts)                                                                                                                     |
| Active-org resolution (`X-Org-Id`, SSO guard)                 | [`packages/backend/src/middleware/org-context.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/org-context.ts)                                                                                                                 |
| CSRF middleware                                               | [`packages/backend/src/middleware/csrf.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/csrf.ts)                                                                                                                               |
| Subscription-state middleware                                 | [`packages/backend/src/middleware/subscription-guard.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/subscription-guard.ts)                                                                                                   |
| MFA step-up middleware (`requireMfa`, `requireMfaIfEnrolled`) | [`packages/backend/src/middleware/require-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/require-mfa.ts)                                                                                                                 |
| Role registry and route manifest                              | [`packages/shared/src/permissions.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/permissions.ts), [`packages/shared/src/route-manifest.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/route-manifest.ts) |
| Membership rows and key builders                              | [`packages/backend/src/lib/org-membership.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/org-membership.ts)                                                                                                                         |
| Invitations (rows, token hash, accept transaction)            | [`packages/backend/src/lib/invitations.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/invitations.ts)                                                                                                                               |
| Audit envelope and transactional append                       | [`packages/backend/src/lib/audit.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/audit.ts)                                                                                                                                           |

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

- `createRemoteJWKSet(https://${AUTH0_DOMAIN}/.well-known/jwks.json)` is cached at module scope so warm Lambdas do not refetch ([`auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts)).
- Access tokens are verified with `jwtVerify(token, jwks, { audience, issuer })`.
- ID tokens are verified separately to extract `email`, `email_verified`, `name`, `picture` ([`auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts)). Failure is non-fatal — the user is still authenticated, just without profile claims.

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
  .use(authMiddleware()) // identity, active org, membership, token refresh
  .use(authorize('buckets.read')) // what the caller's role must carry
  .use(requireMfaIfEnrolled()) // optional, for sensitive MFA/account/org routes — see MFA § Step-up
  .use(csrfMiddleware()) // mutations only
  .use(subscriptionGuardMiddleware(AccessLevel.X)) // optional, for billing-gated routes
  .use(errorHandlerMiddleware());
```

Examples: [`list-buckets.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/list-buckets.ts) (read), [`create-bucket.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/create-bucket.ts) (write), [`transfer-ownership.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/transfer-ownership.ts) (the one org route behind a step-up), [`get-me.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/get-me.ts) (`/api/me` skips both the permission and the subscription guard).

`authorize` sits before the subscription guard on purpose: a caller who is not a member, or whose role does not reach the route, gets an authorization error rather than a billing one, and the request skips the `BillingTable` read it was going to be denied after.

### authMiddleware ([`auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts))

`before` hook — three steps, fail-open within reason:

1. **Verify the access token.** If valid, extract `sub`, decode the ID token, attach identity, return.
2. **If invalid/expired, refresh.** POST to `/oauth/token` with `grant_type=refresh_token`. On success, stash new tokens in `request.internal.newTokens`, decode the fresh access token, attach identity. The `after` hook will write the refreshed cookies onto the response.
3. **Last-ditch fallback.** If the request had `?forceRefresh=1` (used after a profile update needs new claims) and the refresh failed, retry the original access token rather than 401-ing the user. Prevents transient Auth0 issues from logging everyone out -> unlikely in practice to happen.

If all three steps fail → 401.

`after` hook — if the handler called `requestTokenRefresh(event)` ([`user-context.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/user-context.ts)) or refresh tokens were minted earlier, write the cookies onto the response.

### Identity resolution: `sub` → `userId` + `orgId`

Implemented in `resolveUserAndOrg` ([`auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/auth.ts)) backed by DynamoDB `UserInfoTable`.

Look up `pk=SUB#${sub}, sk=IDENTITY`:

- **Hit:** read `userId`, `orgId`. Return.
- **Miss (first login):** one atomic `TransactWriteItems` writes six rows across `UserInfoTable` and `OrgTable`, plus the `org.created` audit event, which makes seven items across three tables ([`lib/account-creation.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/account-creation.ts)):
  - `SUB#${sub} / IDENTITY` (with `attribute_not_exists(pk)` to guard concurrent first logins)
  - `USER#${userId} / PROFILE`
  - `ORG#${orgId} / PROFILE` with `auroraSetupStatus: FILONE_ORG_CREATED`, suggested `name`
  - `ORG#${orgId} / META` with `ownerCount: 1` (OrgTable)
  - `ORG#${orgId} / MEMBER#${userId}` with `role: OrgRole.Owner` (OrgTable)
  - `USER#${userId} / MEMBERSHIP#${orgId}`, the inverse item (OrgTable)

Account creation is the one write that lands without its audit event if the audit table refuses: an unrecorded org is recoverable, an account nobody can create is not.

The identity row's `orgId` names the org this login created, which is where a session starts. It is not a limit on how many orgs the user belongs to — see Organizations below.

The new user is now authenticated. Aurora tenant creation is _not_ triggered here — it happens on the org's first resource request, per [`docs/architectural-decisions/2026-05-synchronous-tenant-setup-on-first-resource.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-05-synchronous-tenant-setup-on-first-resource.md).

### CSRF middleware ([`csrf.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/csrf.ts))

Double-submit token. On any non-safe method (anything other than GET/HEAD/OPTIONS), the `X-CSRF-Token` header must equal the `hs_csrf_token` cookie. The SPA reads the cookie and attaches the header in [`api.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts). The token rotates on every token refresh.

## Organizations, membership, and roles

Organizations are FilOne-native. Auth0 owns authentication; who belongs to which org, and what they may do there, is ours. Designed in [`docs/architectural-decisions/2026-08-organizations-roles-m1.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/architectural-decisions/2026-08-organizations-roles-m1.md).

### Membership rows

Membership lives in `OrgTable` as a pair of rows written together, so a membership is either fully present or absent. Key builders in [`lib/org-membership.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/org-membership.ts).

| pk                      | sk                    | Holds                                                    |
| ----------------------- | --------------------- | -------------------------------------------------------- |
| `ORG#${orgId}`          | `MEMBER#${userId}`    | `role`, `joinedAt`, `source` — the org's roster          |
| `USER#${userId}`        | `MEMBERSHIP#${orgId}` | `role`, `joinedAt` — the inverse item, for "which orgs?" |
| `ORG#${orgId}`          | `META`                | `ownerCount`, the last-Owner invariant's counter         |
| `ORG#${orgId}`          | `INVITE#${inviteId}`  | One invitation; the row stays after accept or revoke     |
| `INVITETOKEN#${sha256}` | `LOOKUP`              | The invitation token's hash, so a token finds its invite |

The inverse item is what answers "which organizations does this user belong to" without a table scan or a GSI. Both rows carry the role, and the conversion script's `--verify` compares them.

`ownerCount` exists because the last Owner may not be removed or demoted, and that question cannot be answered by reading one row. A daily cron ([`jobs/owner-count-drift-checker.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/jobs/owner-count-drift-checker.ts)) recounts each org's Owners from the membership rows and repairs a counter that disagrees.

### The four roles

The registry is a frozen table in [`packages/shared/src/permissions.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/permissions.ts), read by the backend to enforce and by the console to decide what to render. A role outside the table carries no permissions, so unrecognized data fails closed.

| Role       | Reach                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`    | Everything: billing, ownership transfer, org deletion, granting and removing Owners, the audit log                                     |
| `admin`    | Members and invitations below Owner, org rename, all buckets, objects and keys, the audit log, and `billing.view` (usage and invoices) |
| `member`   | Buckets and objects, their own keys, and reading the roster                                                                            |
| `readonly` | Reading buckets, objects, and the roster                                                                                               |

Two permissions are narrower than the route that carries them, so the handler finishes the check the route cannot state:

- **`members.manage`** reaches the member routes; whether the caller may touch a given _target_ depends on that target's role, which is a row the middleware has not read. Touching an Owner at all — promoting to, demoting from, removing — costs `owners.manage`.
- **`keys.manage_own`** reaches the key list and delete routes; the handler compares the caller against the row's `createdBy` ([`lib/key-scope.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/key-scope.ts)). A key minted before attribution shipped names no creator and is therefore visible and revocable only under `keys.manage_all`.

Every route declares its category and requirement in [`packages/shared/src/route-manifest.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/route-manifest.ts), and a backend test walks `src/handlers/` and fails on any handler the manifest does not name.

### The active org: `X-Org-Id`

A request names the org it acts in with the `X-Org-Id` header. Resolution runs inside `authMiddleware`, in [`middleware/org-context.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/org-context.ts):

1. **No header** — the active org is the identity row's `orgId`. This is what a `curl` caller gets, and what every request looked like before M1.
2. **Header present** — it must be an organization id, or the request is refused with 400. The value is lowercased, because the key comparison is byte-for-byte.
3. **Membership is read for the resolved org, before the org's profile.** A caller with no membership row there gets 403 `NOT_A_MEMBER`. Reading membership first is the security property: the profile read must not be able to answer for an org the caller does not belong to.
4. **SSO enforcement.** If the org's profile carries an `auth0OrgId` and the session's claim does not match, the request is refused — an org that requires its own identity provider is not reachable through a personal login. A profile that cannot be read is a 503, not a pass.

`GET /api/me` is the one route that answers instead of refusing when the header names an org the caller is not in: it falls back to their own org and reports which org it served. The console keeps the active org per tab, and this response is what tells it the stash has gone stale. Refusing here would lock the console out of the only endpoint that could correct it.

Role and membership changes take effect on the next request. There is no session to revoke, because nothing about the role is carried in the token.

### Invitations

An invitation is a row plus a single-use token, and the token exists only in the email — the console never sees it and cannot resend it as a link. Accepting is one transaction that creates the membership pair, increments the counter when the invited role is Owner, marks the invitation `accepted`, deletes the token lookup, and appends the audit event. That delete, plus a `status = pending` condition on the row, is what makes the token single-use. The row itself survives: expiry is a read-time comparison rather than a TTL delete, so the M2 audit export can still see it.

Accepting is the one authenticated route with no org gate at all: the caller is not a member of the inviting org yet, so a membership check would refuse every invitation there is. Its authorization is the token plus a session whose verified email is the invited address, both checked in the handler.

Creating an invitation is gated on the organizations beta flag — see [`bin/README.md`](https://github.com/filecoin-project/fil-one/blob/main/bin/README.md) for where the flag lives and how to grant it. Nothing downstream of an invitation existing is flagged: accepting, the roster, role changes, removal, and transfer never read it. The same flag reaches the console as `MeResponse.orgsBeta`, where it decides whether the Members nav entry and `/members` render for a caller who belongs to exactly one org. A caller with two or more memberships gets that surface either way.

### Ownership transfer

Transfer is the only org action behind a step-up, because it is the only verb that takes the caller's own authority away: the outgoing Owner lands as Admin, and Admin cannot promote anyone back. `requireMfaIfEnrolled()` runs after `authorize('org.transfer')`, so a non-Owner is refused before being sent on an Auth0 round trip.

The step-up sends `max_age=0` rather than reading `amr` alone, which is what makes it work for a federated login whose identity provider never emits an `mfa` signal: a fresh `auth_time` is the evidence either way.

### The audit log

Org, membership, and key events are written to `AuditTable`, keyed `ORG#${orgId}` / `${createdAt}#${eventId}` with a 90-day TTL. Pure-DynamoDB mutations commit through `commitAudited`, which appends the event to the caller's own transaction — so the mutation and its record land together or not at all. Mutations that call a vendor first (minting and revoking S3 access keys) write an intent event before the call and a completion after it, correlated by id.

Reading the log costs `audit.view`, which Owner and Admin hold.

## Subscription-state gating

The second gate. The role says whether the caller may make this kind of request; the subscription says whether the organization is currently entitled to have it served. Implemented in [`subscription-guard.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/subscription-guard.ts).

### AccessLevel

Two levels, applied per route:

```ts
const AccessLevel = {
  Read: 'read',
  Write: 'write',
} as const;
type AccessLevel = (typeof AccessLevel)[keyof typeof AccessLevel];
```

These two levels are about entitlement, not about who the caller is. Role-based distinctions belong in the permission registry above.

### Subscription state machine

States are held on the org's billing record (`BillingTable`, key `ORG#${orgId} / SUBSCRIPTION`) and updated by the Stripe webhook ([`stripe-webhook.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/stripe-webhook.ts)). The middleware also performs _lazy_ transitions on read.

The subscription belongs to the organization, so every member of a paid org is covered by one subscription and the seat that pays is not a person. `CUSTOMER#${userId}` is the retired shape: nothing reads or writes those rows. What still recognizes them is the trial claim, which refuses to mint a trial while a pre-re-key row stands, and the migration scripts in [`bin/`](https://github.com/filecoin-project/fil-one/blob/main/bin) that move and then delete them. See [`docs/BillingRekeyRunbook.md`](https://github.com/filecoin-project/fil-one/blob/main/docs/BillingRekeyRunbook.md).

| Stripe state                      | Read                            | Write                                | Notes                                                                                                              |
| --------------------------------- | ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| (no billing record)               | allow only if entitled\*\*      | allow only if entitled\*\*           | `ensureTrialEntitlement` claims `EMAIL_NORM#<email>/TRIAL_ENTITLEMENT`; losers get **403 `SUBSCRIPTION_INACTIVE`** |
| (record, no `subscriptionStatus`) | **403 `SUBSCRIPTION_INACTIVE`** | **403 `SUBSCRIPTION_INACTIVE`**      | e.g. the customer-mapping record `create-setup-intent` writes — no status means no entitlement                     |
| `Active`                          | allow                           | allow                                |                                                                                                                    |
| `Trialing`                        | allow\*                         | allow\*                              | If `trialEndsAt < now`, lazily transition to `GracePeriod`                                                         |
| `GracePeriod`                     | allow                           | **403 `GRACE_PERIOD_WRITE_BLOCKED`** | If `gracePeriodEndsAt < now`, lazily transition to `Canceled`                                                      |
| `PastDue`                         | allow                           | **403 `GRACE_PERIOD_WRITE_BLOCKED`** | Same write-block as grace period                                                                                   |
| `Canceled`                        | **403 `SUBSCRIPTION_CANCELED`** | **403 `SUBSCRIPTION_CANCELED`**      |                                                                                                                    |
| `Inactive`                        | **403 `SUBSCRIPTION_INACTIVE`** | **403 `SUBSCRIPTION_INACTIVE`**      | Synthetic read-model status, never persisted; `GET /api/billing` reports it for the two denied rows above          |
| Unknown / unhandled               | **403 `SUBSCRIPTION_INACTIVE`** | **403 `SUBSCRIPTION_INACTIVE`**      | Fail closed                                                                                                        |

\*\* One trial per normalized email, verified emails only — see [`trial-entitlement.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/trial-entitlement.ts).

`GET /api/billing` reports the same truth as this guard: an account the guard denies is reported as `{subscription: {planId: 'none', status: 'inactive'}}` (the standard `BillingInfo` envelope), never as a synthesized trial.

Grace-period durations live in [`packages/shared/src/constants.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/constants.ts) (`TRIAL_GRACE_DAYS`, `PAID_GRACE_DAYS`).

The middleware also stashes the resolved `subscriptionStatus` on `event.requestContext.subscriptionStatus` so handlers can branch on it without a second DDB read.

### Where it's applied

Search: `grep -rn "subscriptionGuardMiddleware" packages/backend/src/handlers`. Fifteen handlers today:

- **Read-gated:** `list-buckets`, `get-bucket`, `get-bucket-analytics`, `get-bucket-rag-enablement`, `list-access-keys`, `list-rag-api-keys`, `presign`, `query-bucket`
- **Write-gated:** `create-bucket`, `delete-bucket`, `create-access-key`, `delete-access-key`, `create-rag-api-key`, `delete-rag-api-key`, `set-bucket-rag-enablement`

The RAG surface rides the same guard: `/api/rag-api-keys`, `/api/buckets/{name}/query`, and `/api/buckets/{name}/rag/enabled`.

Notably _not_ gated: `/api/me`, `/api/me/resend-verification`, anything under `/api/auth/*`, `/api/mfa/*`, `/api/billing/*`, the org and member routes, `stripe-webhook` (signature-verified, no auth middleware at all).

The org and member routes stay off this guard deliberately. Managing who is in the organization is how an account recovers, and an org whose subscription lapsed still needs to be able to change its own Owner.

### Stripe webhook

[`stripe-webhook.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/stripe-webhook.ts) has no auth middleware. It verifies the signature with `stripe.webhooks.constructEvent`, claims the event ID via a conditional DDB write for idempotency, then updates `BillingTable` based on the Stripe event. Webhook secret is in SSM.

## Frontend

The SPA (React + TanStack Router, `packages/website`) is the only client. It does not store tokens — it relies on the cookies set by the BFF. Simple & secure.

### Login / logout

[`packages/website/src/lib/api.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts) — `redirectToLogin()` is a `window.location.href = ${API_URL}/login` redirect. Logout works the same way against `/logout`. There is no SPA-side OAuth code; all of it happens in the Lambda BFF.

### Route guarding

[`packages/website/src/routes/_app.tsx`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/routes/_app.tsx) protects the authenticated app shell:

1. If the JS-readable `hs_logged_in` cookie is missing → redirect to `/login` (no round-trip).
2. Otherwise prefetch `/api/me` (cached via TanStack Query in [`query-client.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/query-client.ts)).
3. If `emailVerified=false` → `/verify-email`.
4. Render the app.

### API calls

The fetch wrapper at [`api.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts) does four relevant things:

- `credentials: 'include'` so cookies are sent.
- For mutations, reads `hs_csrf_token` from `document.cookie` and attaches `X-CSRF-Token`.
- Attaches `X-Org-Id` from the per-tab active-org stash ([`lib/active-org.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/active-org.ts)), so two tabs can sit in two organizations.
- On 401, calls `redirectToLogin()` — except the `step_up_required` 401, which becomes a `StepUpRequiredError` for the caller to handle.

The console hides what the server would refuse: `usePermissions()` reads the permission list `/api/me` computes from the same registry the backend enforces, and gated pages render a refusal rather than redirecting. This is presentation only. Every decision is made again on the server.

The Members surface is the one gate that hides something the server would serve: the nav entry and `/members` render on more than one membership or the `orgsBeta` flag, while all four roles hold `members.read` and no server route reads the flag on a read path.

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

### Step-up authorizer

A recovery code is a portable, take-anywhere bypass — a stolen session must not be enough to mint one. The same pattern now guards ownership transfer, which is the other change a walked-away session must not be able to make. Shape:

- **Backend:** `requireMfa()` and `requireMfaIfEnrolled()` middy middleware ([`packages/backend/src/middleware/require-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/require-mfa.ts)). Slots after `authMiddleware` (and after `authorize`, so a caller who cannot make the change is refused before the round trip). Reads `auth_time` from the access token claims already verified by `authMiddleware` and returns `401 { error: 'step_up_required' }` if the authentication is stale or the session carries no MFA signal. A future-dated `auth_time` is refused rather than treated as fresh. The enrollment lookup fails open: denying a user with no MFA would loop them through a redirect that can never satisfy the gate.
- **Token claim:** `auth_time` is injected into the access token by the existing Post-Login Action via `api.accessToken.setCustomClaim('auth_time', ...)` ([`mfa-action.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/jobs/stack-setup/mfa-action.ts)) — sourced from the most recent `event.authentication.methods[].timestamp`. Updating the Action requires bumping the stack-setup function version (a plain string defined in SST — not tied to a version format) so it actually redeploys to Auth0. The same setup function configures more than the Action, so any change it deploys (Action source, callbacks, email provider, etc.) needs a bump.
- **Frontend:** the `apiRequest` wrapper ([`packages/website/src/lib/api.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/api.ts)) throws `StepUpRequiredError` on the `step_up_required` 401, and [`lib/step-up.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/website/src/lib/step-up.ts) stashes an action plus a return path and redirects to `/login` with `acr_values` and `max_age=0`. `max_age=0` forces a fresh authentication rather than reusing the Auth0 session, so the new ID token carries a current `auth_time`. That is the step-up signal for a user whose identity provider never emits `mfa` in `amr` — a federated login, where the challenge is not ours to issue.
- **On return:** the app root reads the stash and sends the caller back to the page, which reopens its confirmation rather than resubmitting. A change that cannot be reversed by the person making it should not fire off the back of a redirect they may have abandoned.
- **Consumers:** `POST /api/mfa/recovery-code/regenerate`, `POST /api/mfa/disable`, `DELETE /api/mfa/enrollments/{enrollmentId}`, individual passkey deletes, and `POST /api/org/transfer`. The first four run `requireMfa()`; transfer runs `requireMfaIfEnrolled()`.

Engineers adding a new sensitive endpoint should reach for `requireMfa` rather than rolling their own freshness check. For instance, account deletion might want a forced login prior to allowing.

Broader step-up coverage is open: granting Owner through an invitation or a role change is not gated today. See FIL-945.

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
  orgId: string; // The ACTIVE org for this request, after X-Org-Id resolution
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  personalOrgId?: string; // The identity row's org, when the header named another
  membership?: OrgMembership; // The caller's row in the active org
  apiKeySession?: true; // Minted from an API key rather than a login
}
```

`membership` is the row itself, not a flattened permission list. Permissions are derived from the role with `permissionsForRole` wherever they are needed, because a cached second copy of derived state is one more thing that can disagree with the row. The row is also where per-member scope will land, so its consumers get that with no new plumbing.

Handlers read it via `getUserInfo(event)`. If a handler mutates Auth0 user data and needs the response cookies to carry fresh ID-token claims (e.g., name change), it calls `requestTokenRefresh(event)` and the auth middleware's `after` hook performs a refresh before writing cookies.

## Where to look next when extending this

- **Adding a new authenticated route:** copy the middy chain from [`list-buckets.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/list-buckets.ts) (read) or [`create-bucket.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/handlers/create-bucket.ts) (write). Register it in [`sst.config.ts`](https://github.com/filecoin-project/fil-one/blob/main/sst.config.ts) and pass the env vars through.
- **Adding a sensitive MFA / account route:** add `requireMfaIfEnrolled()` ([`packages/backend/src/middleware/require-mfa.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/middleware/require-mfa.ts)) after `authorize` and before `csrfMiddleware`. Don't roll your own freshness check. See MFA § Step-up authorizer.
- **Adding a new social/SSO connection:** Auth0 dashboard only — no code change. The authorize URL builder ([`packages/shared/src/auth.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/auth.ts)) already accepts a `connection` hint.
- **Adding a Management API call:** add the function in [`auth0-management.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/backend/src/lib/auth0-management.ts) and grant the scope on the runtime M2M app in the Auth0 dashboard. Document the new scope in the auth ADR's runtime M2M scope table.
- **Adding a permission:** add it to `PERMISSIONS` and to each role's set in [`packages/shared/src/permissions.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/permissions.ts), then declare it on the route in [`route-manifest.ts`](https://github.com/filecoin-project/fil-one/blob/main/packages/shared/src/route-manifest.ts). The manifest test fails a handler that has no entry, and the console reads the same table, so a permission added in one place shows up in both.
- **A permission the route cannot express:** if the answer depends on the request body or on a row the chain has not read, declare `in-handler` and check it against the same registry inside the handler, next to the existing checks. `presign` and the member routes are the two worked examples.

Claude code does a great job in doing this given how consistent we apply the pattern, but make sure to double check the endpoints are correctly configured during review!

## Open considerations for cross-service work

This document exists to support the conversation about extending auth/identity to additional services. Things worth pinning down before that:

- **Trust boundary between services.** Today the BFF is the only thing that holds Auth0 client credentials, talks to the Management API, and reads the user→org mapping. A second service can either (a) call the console API as the source of truth, or (b) verify Auth0 access tokens directly and look up its own `userId/orgId` mapping in `UserInfoTable`. Strong preference for the former since it means no other service needs to deal with our Auth0 instance. We should expose service to service authN/Z mechanism of some sort and define which APIs we want to support for this.
- **Token format for service-to-service.** Auth0 access tokens are issued for `aud=https://app.fil.one`. A separate audience per service (or a federated machine token) is cleaner than reusing the user token.
- **Where authorization decisions live.** All AuthZ decisions live in the backend. Frontend "reacts" to the data and http responses.
- **The role model, shared across services.** Four roles and their permission sets live in `packages/shared`, and the backend and console already read the same table. A second service should read it too rather than mapping its own vocabulary. Organizations are FilOne-native rather than Auth0 Organizations; the ADR records why, and what changes if enterprise SSO makes Auth0's construct worth adopting for the connection alone.
- **Service to Service AuthN/Z**. We have 2 kinds of operations we implicitly support: 1. User operations, 2. (S3) Service operations.
  - _User operations_ include things like billing changes, org name changes, viewing S3 usage dashboard, etc. This is the core Console API and these are all user interactions. These things could expand to service operations with a different AuthN/Z model if we are supporting external developer customers to programmatically do these things (very large amount of work).
  - _Service operations_ are S3 operations: PutObject, get object, head object (read metadata), etc. These directly call Aurora through presigned urls and have no need (or want) to go through our Console API layer. We have a secret Access Key we manage on their behalf and we can still do this while abiding by any User Permission model we decide on.
  - _Slightly ambiguous_ since these are only accessible to users right now, but should likely be considered service operations since they are supported by S3: things like Creating Aurora Buckets, Creating Aurora access keys, etc. Right now, we use special permissions with service to service auth with aurora for these operations since they are not supported in the S3 layer. I'd argue these are spiritually _Service operations_ and worth unifying with any permission model we expose with the other service operations in the same way AWS IAM does for S3 + other service. But as of today they are user operations.

So, in summary, Auth0 is the source of truth for user identity, and FilOne is the source of truth for organizations, membership, and what a role may do. User authorization is settled for the console: four roles, one registry, enforced per route. What is still open is service operations — we implicitly have another set of APIs for service-level operations that is currently gated only by user-specific authN/Z and should be expanded to support callers outside our console. The service operations for S3 are supported through sigv4 signed via console-managed access keys tied to a user and organization, and those keys now carry the identity of the member who minted them.
