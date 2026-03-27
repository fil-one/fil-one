# ADR: Remove Local Sign-In/Sign-Up Screens in Favor of Direct Auth0 Redirect

**Status:** Accepted
**Date:** 2026-03-25

## Context

The Hyperspace SPA previously rendered custom sign-in and sign-up pages that collected an email address and offered social provider buttons (Google, GitHub). All paths ultimately called `redirectToLogin()`, which built an Auth0 `/authorize` URL client-side and navigated the browser there. The local pages added no value beyond what Auth0 Universal Login already provides and introduced two problems:

1. **Latency on first visit.** A user arriving at `/sign-in` via a bookmark or external link had to download and parse the full SPA bundle before the redirect to Auth0 could execute.
2. **No stable, bookmarkable login URL.** The Auth0 authorize URL includes a one-time `state` parameter and a corresponding browser cookie. Both are generated client-side by `buildAuth0LoginUrl()`, so the final URL cannot be shared or bookmarked. Hitting the Auth0 URL directly (without the cookie) fails CSRF validation in the callback handler.

## Decision

Remove the local sign-in and sign-up UI. Replace with two redirect mechanisms:

### 1. Server-side entry point: `GET /login`

A new Lambda handler that generates the OAuth `state`, sets the `hs_oauth_state` cookie, and returns a 302 to Auth0's `/authorize` endpoint. Accepts optional query parameters:

- `?screen_hint=signup` — tells Auth0 to show the registration tab
- `?connection=google-oauth2` — skips Universal Login and goes directly to a social provider

This URL is stable and bookmarkable. Each visit generates a fresh state/cookie pair, so CSRF protection is maintained.

### 2. Client-side 401 handling: `redirectToLogin()`

When the SPA is already loaded and a 401 response triggers re-authentication, `redirectToLogin()` navigates to `/login` via `window.location.href`. This is a simple redirect — no Auth0 configuration is needed in the frontend.

**Why not return a 302 from the auth middleware instead?** The SPA makes API calls via `fetch()`, which follows HTTP redirects automatically and transparently. If the middleware returned a 302 to `/login`, fetch would silently follow the redirect chain (middleware → `/login` → Auth0) and return Auth0's HTML login page as the response body — the browser would never actually navigate. Only top-level document requests (link clicks, form submits, `window.location`) trigger real browser navigation on a 302. The 401 status code is the correct signal for "session expired" — it lets the client-side code perform a real navigation via `window.location.href`.

### Shared URL builder: `buildAuth0AuthorizeUrl()`

The `/login` Lambda uses `buildAuth0AuthorizeUrl()` from `@filone/shared` to construct the Auth0 URL. This is a pure function (no side effects) that takes domain, client ID, audience, redirect URI, state, and optional hints as parameters. The caller is responsible for generating the state value and persisting it. Having the URL builder in `@filone/shared` keeps the logic reusable if a second server-side caller is ever needed.

### Auth0 configuration removed from frontend

Because all login paths now go through `/login`, the frontend no longer needs Auth0 credentials. The `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, and `VITE_AUTH0_AUDIENCE` environment variables have been removed from the SPA bundle, `.env.local`, and `.env.production`. Auth0 configuration lives exclusively in the backend (SST secrets and Lambda environment variables).

### Route behavior

- `/sign-in` — TanStack Router `beforeLoad` redirects to `/login`
- `/sign-up` — redirects to `/login?screen_hint=signup`
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

These values are set via SST Resource bindings and injected into the Lambda environment at deploy time — they are not stored in `.env` files or source code.

| Parameter         | Staging                             | Production                   |
| ----------------- | ----------------------------------- | ---------------------------- |
| `AUTH0_DOMAIN`    | `dev-oar2nhqh58xf5pwf.us.auth0.com` | _(prod tenant when created)_ |
| `AUTH0_CLIENT_ID` | `hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ`  | _(prod client ID)_           |
| `AUTH0_AUDIENCE`  | `https://staging.fil.one`           | _(prod audience)_            |

### Example: staging

```
https://staging.fil.one/sign-in
  → 302 /login
  → 302 https://dev-oar2nhqh58xf5pwf.us.auth0.com/authorize?client_id=hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ&redirect_uri=https%3A%2F%2Fstaging.fil.one%2Fapi%2Fauth%2Fcallback&...&state=<uuid>
```

### Example: CloudFront-only (no custom domain)

```
https://dc6bx6mfz5y94.cloudfront.net/sign-in
  → 302 /login
  → 302 Auth0 authorize URL with redirect_uri=https%3A%2F%2Fdc6bx6mfz5y94.cloudfront.net%2Fapi%2Fauth%2Fcallback
```

The CloudFront distribution URL must be registered as an Allowed Callback URL in the Auth0 application settings (handled automatically by the `setup-integrations` stack job on deploy).

### Direct API entry point (bookmarkable)

```
https://staging.fil.one/login
https://staging.fil.one/login?screen_hint=signup
```

These can be linked from external sites, emails, or documentation without requiring the SPA to load.

## Logout redirect

After clearing session cookies, the logout handler redirects to Auth0's `/v2/logout` endpoint with `returnTo=https://fil.one`. This sends the user to the marketing site rather than back into the login flow. The `returnTo` is hardcoded to `https://fil.one` rather than derived from the request origin because the application is only deployed at that domain. `https://fil.one` must be registered in the Auth0 application's Allowed Logout URLs (handled by the `setup-integrations` stack job).

## Consequences

- External links and bookmarks can point to `/login` for immediate server-side redirect without loading JS.
- Auth0 configuration (`VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`) has been fully removed from the frontend bundle. Auth0 credentials live exclusively in the backend, reducing the attack surface of the SPA.
- The `SignInPage` and `SignUpPage` components are now unused and can be removed.
- Logout returns users to `https://fil.one` via Auth0's `/v2/logout` with `returnTo=https://fil.one`, taking them to the marketing site rather than back into the login flow.
