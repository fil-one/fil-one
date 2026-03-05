# Authentication

## Constraints

- We do not want to handle credentials ourselves
- Enterprise clients — must look and feel polished while being secure
- HTTP-only cookies required for session management
- Must support social login (Google, GitHub) in addition to email/password and enterprise SSO
- Integration with SPA (or SSR if we go that route)

---

## BFF (Backend-for-Frontend) Pattern

Regardless of auth provider, the SPA cannot safely hold tokens in JS memory or localStorage. We need a backend component to handle the OAuth token exchange and set HTTP-only cookies.

### If hosting website on Vercel (Next.js)

Vercel API routes act as the BFF. Same-origin cookies, no CORS headaches. Auth logic lives at the edge, EKS Console API receives pre-authenticated requests with a service-to-service token.

```
Browser → Vercel (Next.js API routes handle auth + cookie) → EKS Console API
```

### If hosting website on AWS

Console API on EKS is the BFF. Handles token exchange, sets HTTP-only cookie (`Secure`, `SameSite=Strict`), validates cookie on every request.

```
Browser → Console API on EKS (handles auth + cookie) → internal services
```

### Cookie Configuration

Regardless of hosting, the session cookie should be:
- `HttpOnly` — not accessible via JS, prevents XSS token theft
- `Secure` — only sent over HTTPS
- `SameSite=Strict` (or `Lax` if cross-origin redirect is needed during OAuth callback)
- Scoped to the appropriate domain (e.g., `.hyperspace.xyz` if frontend and API are on subdomains)

### Auth Flow (OAuth2 Authorization Code with PKCE)

```
┌──────────┐         ┌─────────────┐         ┌──────────────┐
│  Browser  │         │     BFF     │         │ Auth Provider │
│   (SPA)   │         │             │         │              │
└─────┬─────┘         └──────┬──────┘         └──────┬───────┘
      │                      │                       │
      │  1. Click "Login"    │                       │
      │  (or "Login with     │                       │
      │   Google/GitHub")    │                       │
      │─────────────────────>│                       │
      │                      │                       │
      │  2. Redirect to auth provider login page     │
      │     (with social provider hint if applicable)│
      │<─────────────────────────────────────────────│
      │                      │                       │
      │  3. User authenticates                       │
      │     (email/password, Google, GitHub, SSO)    │
      │─────────────────────────────────────────────>│
      │                      │                       │
      │  4. Redirect back with authorization code    │
      │──────────────────────>                       │
      │               /auth/callback                 │
      │                      │  5. Exchange code      │
      │                      │     for tokens         │
      │                      │──────────────────────>│
      │                      │                       │
      │                      │  6. Receive ID token + │
      │                      │     access token +     │
      │                      │     refresh token      │
      │                      │<──────────────────────│
      │                      │                       │
      │  7. Set HTTP-only    │                       │
      │     secure cookie    │                       │
      │<─────────────────────│                       │
      │                      │                       │
      │  8. Subsequent API   │                       │
      │     calls include    │                       │
      │     cookie auto      │                       │
      │─────────────────────>│                       │
      │                      │  9. Validate/refresh   │
      │                      │     as needed          │
```

The BFF pattern is identical for all providers. Social login (Google, GitHub) is handled by passing a `connection` or `provider` hint in step 2 so the auth provider skips its login screen and redirects directly to Google/GitHub's OAuth consent page.

---

## Provider Options

### 1. Clerk (Recommended if using Vercel)

First-class Vercel/Next.js integration. Middleware handles HTTP-only cookies, token refresh, and session validation automatically. Pre-built UI components (`<SignIn />`, `<UserButton />`) that look polished out of the box. Enterprise SSO (SAML) on paid plans. Organizations/multi-tenancy built in.

- Social login: Google, GitHub, and others supported out of the box
- Pros: Best Vercel/Next.js DX, least custom code, polished UI, enterprise SSO
- Cons: Newer company (less battle-tested at scale), pricing can be high at hundreds of thousands of users, no web3/wallet story

**Integration (Next.js):**
```
1. pnpm install @clerk/nextjs
2. Wrap app in <ClerkProvider>
3. Add Clerk middleware — automatically protects routes + manages session cookie
4. Use <SignIn /> component (has Google/GitHub buttons built in)
5. Access session in API routes via auth() helper
6. Proxy authenticated requests to EKS with service token
```

### 2. Auth0 (Recommended if enterprise SSO depth is critical)

Premium enterprise auth platform. Universal Login page is highly customizable and polished. "Organizations" feature is purpose-built for B2B SaaS (per-org SSO, branding, MFA policies). Works well on both Vercel (`nextjs-auth0` SDK) and AWS.

- Social login: Google, GitHub, and 50+ social/enterprise connections supported
- Pros: Best-in-class enterprise SSO (SAML, OIDC federation, directory sync), Actions/Hooks for custom logic, battle-tested, massive ecosystem
- Cons: Most expensive option, enterprise features require paid plans

**Integration (Next.js):**
```
1. pnpm install @auth0/nextjs-auth0
2. Configure AUTH0_* env vars
3. Add /api/auth/[auth0] catch-all API route — handles login, callback, logout
4. Middleware validates session cookie on protected routes
5. Configure Google + GitHub as "Social Connections" in Auth0 dashboard
6. Use withPageAuthRequired() for server-side page protection
7. Access session via getSession() in API routes, proxy to EKS
```

**Integration (Express/EKS — if no Vercel):**
```
1. pnpm install express-openid-connect
2. Configure auth middleware with Auth0 issuer, client ID/secret
3. Middleware handles /login, /callback, /logout routes
4. Sets HTTP-only session cookie automatically
5. req.oidc.isAuthenticated() + req.oidc.user available on all routes
6. Configure Google + GitHub in Auth0 dashboard
```

### 3. AWS Cognito (Pragmatic if staying fully on AWS)

Native AWS integration (IAM, Secrets Manager, EKS). Supports SAML federation for enterprise SSO. Low cost (~$0.0055/MAU after free tier). If website hosting moves to Vercel, Cognito loses its main advantage — it becomes just another external OIDC provider with worse DX than Auth0 or Clerk.

- Social login: Google, GitHub, Facebook, Apple, SAML, OIDC — configured as identity providers on the user pool
- Pros: Cheapest, native AWS integration, no additional vendor
- Cons: Hosted UI looks dated (custom UI likely needed), Cognito quirks are well-documented pain points, less compelling outside AWS

**Integration (Express/EKS):**
```
1. Create Cognito User Pool + App Client
2. Add Google + GitHub as external identity providers on the user pool
3. Use Cognito Hosted UI or build custom UI calling Cognito APIs
4. Backend handles /auth/callback — exchanges authorization code for tokens via Cognito token endpoint
5. Store tokens in HTTP-only cookie (you manage this yourself)
6. Validate JWT on each request using cognito-express or manual JWKS verification
```

**Note:** Cognito does not manage HTTP-only cookies for you. Unlike Clerk or Auth0 SDKs, you must implement the cookie layer yourself.

### 4. Magic.link (Conditional — only if web3 identity is strategic)

Passwordless auth via email magic links and WebAuthn. Web3-native (DID tokens, wallet-based auth) which aligns with Filecoin ecosystem.

- Social login: Google, GitHub, and others supported via their Social Logins add-on
- Pros: Passwordless UX, web3 identity story, clean SDK
- Cons: Gives you a DID token not a session — you must build the session/cookie layer yourself. No built-in SAML SSO federation. Email magic links have UX friction (context-switch to email, delays, spam filters) that enterprise users may not love.

**Integration:**
```
1. pnpm install magic-sdk @magic-sdk/admin
2. Client-side: magic.auth.loginWithMagicLink() or magic.oauth.loginWithRedirect('google')
3. Returns a DID token (not a session cookie)
4. Client sends DID token to your BFF
5. BFF validates DID token server-side using @magic-sdk/admin
6. BFF creates its own session, sets HTTP-only cookie
7. All subsequent requests use your custom session — Magic is only used at login time
```

**Note:** Magic requires the most custom session management of all options.

### 5. Auth.js (Open source framework — if provider flexibility matters)

De facto open-source auth framework for Next.js. Supports Cognito, Auth0, Magic, and dozens of other providers as backends. Built-in HTTP-only cookie sessions, API route handlers, middleware.

- Social login: Google, GitHub, and dozens of others as built-in providers — each is a few lines of config
- Pros: No vendor lock-in on auth framework, swap providers without rewriting code, free
- Cons: You own the integration and maintenance, less polished than managed solutions

**Integration (Next.js):**
```
1. pnpm install next-auth
2. Configure providers in auth config:
   providers: [Google({...}), GitHub({...})]
3. Add /api/auth/[...nextauth] catch-all route
4. Built-in HTTP-only cookie session — no custom cookie management
5. Use useSession() client-side, getServerSession() server-side
6. Add Cognito or Auth0 as additional providers if needed later
```

---

## Summary

| Hosting | Top Pick | Runner Up |
|---------|----------|-----------|
| Vercel + Next.js | Clerk | Auth0 via `nextjs-auth0` |
| AWS only | Auth0 | Cognito (if cost is primary concern) |
| Either (max flexibility) | Auth.js + any OIDC provider | Auth0 |
| Web3 identity required | Magic.link (+ custom session layer) | — |

### Social Login Support Matrix

| Provider | Google | GitHub | Custom SSO (SAML) | Wallet/Web3 | Session Cookie Managed |
|----------|--------|--------|-------------------|-------------|----------------------|
| Clerk | Yes | Yes | Yes (paid) | No | Yes (automatic) |
| Auth0 | Yes | Yes | Yes (paid) | No | Yes (via SDK) |
| Cognito | Yes | Yes | Yes | No | No (DIY) |
| Magic.link | Yes | Yes | No | Yes | No (DIY) |
| Auth.js | Yes | Yes | Via provider | Via provider | Yes (built-in) |

---

## Note on Vercel + SSR

If we go with Vercel, SSR becomes essentially free (it's the default with Next.js). This would flip the SPA recommendation — SSR gives us server-side session access, API route BFF, and faster first paint at no additional operational cost.

---

## Open Questions

1. Are we going with Vercel or AWS for website hosting? This is the primary decision that drives the auth recommendation.
2. Do we need enterprise SSO (SAML) from day one, or can we add it later?
3. Is web3 identity (wallet-based login) a strategic requirement or a nice-to-have?
4. What is the budget tolerance for auth? (Clerk/Auth0 at hundreds of thousands of users will have meaningful monthly cost.)
