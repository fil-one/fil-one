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
  return `https://${options.domain}/authorize?${params.toString()}`;
}
