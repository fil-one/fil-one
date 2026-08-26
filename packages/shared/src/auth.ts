/** Options for building the Auth0 authorize URL. */
export interface Auth0LoginUrlOptions {
  /** Auth0 tenant domain (e.g. 'dev-oar2nhqh58xf5pwf.us.auth0.com'). */
  domain: string;
  /** Auth0 application client ID. */
  clientId: string;
  /** Auth0 API audience identifier. */
  audience: string;
  /** Where Auth0 should redirect after authentication. */
  redirectUri: string;
  /** Opaque state value for CSRF protection. */
  state: string;
  /** Pre-fill the email field in Auth0 Universal Login. */
  loginHint?: string;
  /** 'signup' to show the registration tab instead of login. */
  screenHint?: 'signup';
  /** Auth0 connection name (e.g. 'google-oauth2', 'github') to skip Universal Login. */
  connection?: string;
  /** OIDC acr_values — e.g. PAPE multi-factor URI to request MFA via Auth0. */
  acrValues?: string;
  /**
   * OIDC `max_age`, in seconds: the oldest authentication Auth0 may honor
   * without prompting again. A step-up sends `0`, which forces a fresh
   * authentication and stamps a new `auth_time` on the ID token.
   *
   * This is what makes step-up mean something for a federated user, where `amr`
   * never carries `mfa` and Guardian holds no enrollment: "authenticated moments
   * ago at your own identity provider" is the signal we can actually get, and
   * `max_age` is how we ask for it.
   */
  maxAge?: number;
  /**
   * Auth0 organization id, reserved and unused in M1: organizations are FilOne's
   * own rows, and Auth0 learns about one only when the first enterprise customer
   * arrives with an identity provider.
   *
   * It is plumbed now because a step-up round trip must never be the place org
   * context silently drops — the day a session is org-scoped, every authorize
   * URL we build has somewhere to carry it.
   */
  organization?: string;
}

/**
 * Build the Auth0 `/authorize` URL from the given parameters.
 *
 * This is a pure function with no side effects — callers are responsible for
 * generating the `state` value and persisting it (e.g. as a cookie) before
 * redirecting.
 */
export function buildAuth0AuthorizeUrl(options: Auth0LoginUrlOptions): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    audience: options.audience,
    state: options.state,
  });
  if (options.loginHint) params.set('login_hint', options.loginHint);
  if (options.screenHint) params.set('screen_hint', options.screenHint);
  if (options.connection) params.set('connection', options.connection);
  if (options.acrValues) params.set('acr_values', options.acrValues);
  // Zero is the value that matters, so the test is on absence rather than on
  // truthiness: `max_age=0` is the step-up request itself.
  if (options.maxAge !== undefined) params.set('max_age', String(options.maxAge));
  if (options.organization) params.set('organization', options.organization);
  return `https://${options.domain}/authorize?${params.toString()}`;
}
