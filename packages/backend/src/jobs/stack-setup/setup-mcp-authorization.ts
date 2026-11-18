import { getAuth0ManagementToken } from './auth0-mgmt-token.ts';
import { throwIfNotOk } from '../../lib/auth0-management.ts';

/**
 * The console's sign-in connections. An MCP client is a third-party
 * application, and those can use only connections enabled at the domain level.
 */
export const MCP_SIGN_IN_CONNECTIONS = [
  'Username-Password-Authentication',
  'google-oauth2',
  'github',
];

interface Auth0Connection {
  id: string;
  name: string;
  is_domain_connection?: boolean;
}

/**
 * Let MCP clients sign a console user in through Auth0 and get a token for the
 * MCP endpoint:
 * - an API whose identifier is the MCP endpoint's URL, the tokens' audience;
 * - Client ID Metadata Documents: a client's id is an https URL on its own
 *   domain that serves its metadata, so Auth0 registers it on first use, and
 *   the consent screen names a domain the client controls;
 * - open dynamic client registration off, so no one can create an application
 *   in the tenant without a credential;
 * - the resource-parameter profile, since MCP clients name the API with
 *   `resource` (RFC 8707) rather than Auth0's `audience`;
 * - the console's connections at the domain level, for those clients to use.
 */
export async function setupAuth0McpAuthorization(domain: string, siteUrl: string): Promise<void> {
  const token = await getAuth0ManagementToken(domain);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const api = `https://${domain}/api/v2`;
  const identifier = `${siteUrl}/api/mcp`;

  // The resource-server endpoint takes the identifier in place of the id.
  const getResp = await fetch(`${api}/resource-servers/${encodeURIComponent(identifier)}`, {
    headers,
  });
  if (getResp.status === 404) {
    const createResp = await fetch(`${api}/resource-servers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `Fil One MCP (${new URL(siteUrl).host})`,
        identifier,
        signing_alg: 'RS256',
        // MCP clients keep a session alive with refresh tokens.
        allow_offline_access: true,
      }),
    });
    await throwIfNotOk(createResp, 'Auth0 create MCP resource server failed');
  } else {
    await throwIfNotOk(getResp, 'Auth0 get MCP resource server failed');
  }

  const settingsResp = await fetch(`${api}/tenants/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      flags: { enable_dynamic_client_registration: false },
      client_id_metadata_document_supported: true,
      client_id_metadata_document_dynamic_registration_supported: true,
      resource_parameter_profile: 'compatibility',
    }),
  });
  await throwIfNotOk(settingsResp, 'Auth0 update tenant settings failed');

  for (const name of MCP_SIGN_IN_CONNECTIONS) {
    const listResp = await fetch(`${api}/connections?name=${encodeURIComponent(name)}`, {
      headers,
    });
    await throwIfNotOk(listResp, 'Auth0 list connections failed');
    const connection = ((await listResp.json()) as Auth0Connection[]).find((c) => c.name === name);
    // Not every tenant enables every social provider.
    if (!connection) {
      console.warn('[setup] Auth0 connection not found, skipping for MCP sign-in', { name });
      continue;
    }
    if (connection.is_domain_connection) continue;

    const patchResp = await fetch(`${api}/connections/${connection.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ is_domain_connection: true }),
    });
    await throwIfNotOk(patchResp, `Auth0 enable ${name} for MCP clients failed`);
  }
}
