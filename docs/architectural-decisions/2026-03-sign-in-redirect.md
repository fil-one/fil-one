# ADR: Remove Local Sign-In/Sign-Up Screens in Favor of Direct Auth0 Redirect

**Status:** Accepted
**Date:** 2026-03-25

## Context

The Hyperspace SPA previously rendered custom sign-in and sign-up pages that collected an email address and offered social provider buttons (Google, GitHub). All paths ultimately called `redirectToLogin()`, which built an Auth0 `/authorize` URL client-side and navigated the browser there. The local pages added no value beyond what Auth0 Universal Login already provides and introduced two problems:

1. **Latency on first visit.** A user arriving at `/sign-in` via a bookmark or external link had to download and parse the full SPA bundle before the redirect to Auth0 could execute.
2. **No stable, bookmarkable login URL.** The Auth0 authorize URL includes a one-time `state` parameter and a corresponding browser cookie. Both are generated client-side by `buildAuth0LoginUrl()`, so the final URL cannot be shared or bookmarked. Hitting the Auth0 URL directly (without the cookie) fails CSRF validation in the callback handler.

## Decision

Remove the local sign-in and sign-up UI. Replace with two redirect mechanisms:

### 1. Server-side entry point: `GET /api/auth/login`

A new Lambda handler that generates the OAuth `state`, sets the `hs_oauth_state` cookie, and returns a 302 to Auth0's `/authorize` endpoint. Accepts optional query parameters:

- `?screen_hint=signup` — tells Auth0 to show the registration tab
- `?connection=google-oauth2` — skips Universal Login and goes directly to a social provider

This URL is stable and bookmarkable. Each visit generates a fresh state/cookie pair, so CSRF protection is maintained.

### 2. Client-side fallback: `redirectToLogin()`

When the SPA is already loaded and a 401 response triggers re-authentication, `redirectToLogin()` builds the Auth0 URL and sets the state cookie in the browser. This avoids a Lambda round-trip when the JS bundle is already in memory.

### Shared URL builder: `buildAuth0AuthorizeUrl()`

Both paths use `buildAuth0AuthorizeUrl()` from `@filone/shared` to construct the Auth0 URL. This is a pure function (no side effects) that takes domain, client ID, audience, redirect URI, state, and optional hints as parameters. Callers are responsible for generating the state value and persisting it. Having a single implementation prevents drift between the server-side and client-side flows.

### Route behavior

- `/sign-in` — TanStack Router `beforeLoad` redirects to `/api/auth/login`
- `/sign-up` — redirects to `/api/auth/login?screen_hint=signup`
- The `_auth` layout guard still redirects already-authenticated users to `/dashboard` before the child route's `beforeLoad` runs

## Auth0 Authorize URL Structure

```
https://{AUTH0_DOMAIN}/authorize
  ?client_id={AUTH0_CLIENT_ID}
  &redirect_uri={ORIGIN}/api/auth/callback
  &response_type=code
  &scope=openid+profile+email+offline_access
  &audience={AUTH0_AUDIENCE}
  &state={random-uuid}
  [&screen_hint=signup]
  [&connection=google-oauth2]
```

### Per-environment values

| Parameter         | Staging                             | Production                   |
| ----------------- | ----------------------------------- | ---------------------------- |
| `AUTH0_DOMAIN`    | `dev-oar2nhqh58xf5pwf.us.auth0.com` | _(prod tenant when created)_ |
| `AUTH0_CLIENT_ID` | `hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ`  | _(prod client ID)_           |
| `AUTH0_AUDIENCE`  | `https://staging.fil.one`           | _(prod audience)_            |

### Example: staging

```
https://staging.fil.one/sign-in
  → 302 /api/auth/login
  → 302 https://dev-oar2nhqh58xf5pwf.us.auth0.com/authorize?client_id=hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ&redirect_uri=https%3A%2F%2Fstaging.fil.one%2Fapi%2Fauth%2Fcallback&...&state=<uuid>
```

### Example: CloudFront-only (no custom domain)

```
https://dc6bx6mfz5y94.cloudfront.net/sign-in
  → 302 /api/auth/login
  → 302 Auth0 authorize URL with redirect_uri=https%3A%2F%2Fdc6bx6mfz5y94.cloudfront.net%2Fapi%2Fauth%2Fcallback
```

The CloudFront distribution URL must be registered as an Allowed Callback URL in the Auth0 application settings (handled automatically by the `setup-integrations` stack job on deploy).

### Direct API entry point (bookmarkable)

```
https://staging.fil.one/api/auth/login
https://staging.fil.one/api/auth/login?screen_hint=signup
```

These can be linked from external sites, emails, or documentation without requiring the SPA to load.

## Consequences

- External links and bookmarks can point to `/api/auth/login` for immediate server-side redirect without loading JS.
- Auth0 credential/client configuration is no longer needed in the frontend bundle (`VITE_AUTH0_CLIENT_ID`, etc.) for the login flow, though `redirectToLogin()` still uses them for the 401 path.
- The `SignInPage` and `SignUpPage` components are now unused and can be removed.
- Logout returns users to `/sign-in`, which chains through `/api/auth/login` back to Auth0 — one additional 302 hop but no user-visible delay.
