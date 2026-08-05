/**
 * Auth0 application-config reconciliation for a deployed stage.
 *
 * Every operation is additive and idempotent: a stage registers the URLs it needs
 * without disturbing the ones other stages rely on.
 */
import { Resource } from 'sst';
import { DEFAULT_MARKETING_URL, MARKETING_URL_BY_CONSOLE_ORIGIN } from '@filone/shared';
import { getAuth0ManagementToken } from './auth0-mgmt-token.js';
import { throwIfNotOk } from '../../lib/auth0-management.js';

interface Auth0Client {
  callbacks?: string[];
  allowed_logout_urls?: string[];
  web_origins?: string[];
  initiate_login_uri?: string;
}

async function getAuth0Client(
  domain: string,
  token: string,
  clientId: string,
): Promise<Auth0Client> {
  const resp = await fetch(`https://${domain}/api/v2/clients/${clientId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  await throwIfNotOk(resp, 'Auth0 get client failed');

  return (await resp.json()) as Auth0Client;
}

async function patchAuth0Client(
  domain: string,
  token: string,
  clientId: string,
  patch: Partial<Auth0Client>,
): Promise<void> {
  const resp = await fetch(`https://${domain}/api/v2/clients/${clientId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });

  await throwIfNotOk(resp, 'Auth0 update client failed');
}

function addUnique(existing: string[], value: string): string[] {
  return existing.includes(value) ? existing : [...existing, value];
}

function removeValue(existing: string[], value: string): string[] {
  return existing.filter((v) => v !== value);
}

export async function setupAuth0Callbacks(
  domain: string,
  siteUrl: string,
  aliasSiteUrls: string[],
  isStagingOrProd: boolean,
): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const clientId = Resource.Auth0ClientId.value;
  const client = await getAuth0Client(domain, token, clientId);

  // The same deployment answers on the canonical site URL and on each demo
  // alias, and Auth0 matches callbacks and origins exactly (no wildcards for
  // https in production tenants), so every origin needs its own entry.
  const origins = [siteUrl, ...aliasSiteUrls];
  const loginUrl = `${siteUrl}/login`;

  const patch: Partial<Auth0Client> = {
    callbacks: origins.reduce(
      (acc, origin) => addUnique(acc, `${origin}/api/auth/callback`),
      client.callbacks ?? [],
    ),
    allowed_logout_urls: origins.reduce(
      (acc, origin) =>
        addUnique(acc, MARKETING_URL_BY_CONSOLE_ORIGIN[origin] ?? DEFAULT_MARKETING_URL),
      client.allowed_logout_urls ?? [],
    ),
    web_origins: origins.reduce((acc, origin) => addUnique(acc, origin), client.web_origins ?? []),
  };

  if (isStagingOrProd) {
    // Auth0 allows exactly one initiate_login_uri, so it stays on the canonical
    // host even when aliases are serving the same deployment.
    patch.initiate_login_uri = loginUrl;
  }

  await patchAuth0Client(domain, token, clientId, patch);
}

export async function teardownAuth0Callbacks(
  domain: string,
  siteUrl: string,
  aliasSiteUrls: string[],
  isStagingOrProd: boolean,
): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const clientId = Resource.Auth0ClientId.value;
  const client = await getAuth0Client(domain, token, clientId);

  const origins = [siteUrl, ...aliasSiteUrls];

  const patch: Partial<Auth0Client> = {
    callbacks: origins.reduce(
      (acc, origin) => removeValue(acc, `${origin}/api/auth/callback`),
      client.callbacks ?? [],
    ),
    // Logout URLs are deliberately left alone: they are marketing sites shared
    // by every stage, not per-deployment values, so removing one here would
    // break logout for all the other stages still using it.
    web_origins: origins.reduce(
      (acc, origin) => removeValue(acc, origin),
      client.web_origins ?? [],
    ),
  };

  if (isStagingOrProd) {
    patch.initiate_login_uri = '';
  }

  await patchAuth0Client(domain, token, clientId, patch);
}
