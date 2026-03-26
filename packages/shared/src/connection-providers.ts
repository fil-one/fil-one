/**
 * Metadata for Auth0 connection providers.
 * Add new providers here when adding social login options.
 */

export interface ConnectionProvider {
  /** Display name shown in the UI (e.g. "Google") */
  label: string;
  /** URL where users can manage their profile at this provider */
  profileUrl: string;
}

const providers: Record<string, ConnectionProvider> = {
  'google-oauth2': {
    label: 'Google',
    profileUrl: 'https://myaccount.google.com/personal-info',
  },
  github: {
    label: 'GitHub',
    profileUrl: 'https://github.com/settings/profile',
  },
};

/**
 * Get provider metadata for a given connection type.
 * Returns undefined for database connections ('auth0') or unknown types.
 */
export function getProvider(connectionType: string | undefined): ConnectionProvider | undefined {
  if (!connectionType) return undefined;
  return providers[connectionType];
}

/**
 * Returns true if the connection type is a social/external provider
 * (i.e. not a database connection).
 */
export function isSocialConnection(connectionType: string | undefined): boolean {
  return connectionType !== undefined && connectionType !== 'auth0';
}
