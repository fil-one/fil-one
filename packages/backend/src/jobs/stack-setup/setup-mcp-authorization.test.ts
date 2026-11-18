import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth0-mgmt-token.ts', () => ({
  getAuth0ManagementToken: async () => 'any-mgmt-token',
}));

type FetchInit = { method?: string; body?: string };
const mockFetch = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import { setupAuth0McpAuthorization } from './setup-mcp-authorization.ts';

const DOMAIN = 'any-tenant.auth0.invalid';
const API = `https://${DOMAIN}/api/v2`;
const RESOURCE_SERVER_URL = `${API}/resource-servers/${encodeURIComponent('https://console.test.invalid/api/mcp')}`;

/** A tenant as setup finds it: what the resource-server GET answers, and its connections. */
function stubTenant({
  resourceServerStatus,
  connections,
}: {
  resourceServerStatus: number;
  connections: { id: string; name: string; is_domain_connection?: boolean }[];
}) {
  mockFetch.mockImplementation(async (url, init) => {
    if (url === RESOURCE_SERVER_URL) return new Response('{}', { status: resourceServerStatus });
    if (url.startsWith(`${API}/connections?name=`)) {
      const name = decodeURIComponent(url.split('name=')[1]);
      return Response.json(connections.filter((c) => c.name === name));
    }
    return new Response('{}', { status: init?.method === 'POST' ? 201 : 200 });
  });
}

/** The calls that change the tenant, in order. */
function writes() {
  return mockFetch.mock.calls
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([url, init]) => [init!.method, url, JSON.parse(init!.body!)]);
}

const TENANT_SETTINGS_WRITE = [
  'PATCH',
  `${API}/tenants/settings`,
  {
    flags: { enable_dynamic_client_registration: false },
    client_id_metadata_document_supported: true,
    client_id_metadata_document_dynamic_registration_supported: true,
    resource_parameter_profile: 'compatibility',
  },
];

describe('setupAuth0McpAuthorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('creates the MCP API, turns on CIMD in place of open registration and shares the console’s connections on a fresh tenant', async () => {
    stubTenant({
      resourceServerStatus: 404,
      connections: [
        { id: 'con-db', name: 'Username-Password-Authentication' },
        { id: 'con-google', name: 'google-oauth2', is_domain_connection: false },
        // No github connection: a tenant without that provider is skipped.
      ],
    });

    await setupAuth0McpAuthorization(DOMAIN, 'https://console.test.invalid');

    expect(writes()).toStrictEqual([
      [
        'POST',
        `${API}/resource-servers`,
        {
          name: 'Fil One MCP (console.test.invalid)',
          identifier: 'https://console.test.invalid/api/mcp',
          signing_alg: 'RS256',
          allow_offline_access: true,
        },
      ],
      TENANT_SETTINGS_WRITE,
      ['PATCH', `${API}/connections/con-db`, { is_domain_connection: true }],
      ['PATCH', `${API}/connections/con-google`, { is_domain_connection: true }],
    ]);
  });

  it('leaves an existing MCP API and domain-level connections as they are', async () => {
    stubTenant({
      resourceServerStatus: 200,
      connections: [
        { id: 'con-db', name: 'Username-Password-Authentication', is_domain_connection: true },
      ],
    });

    await setupAuth0McpAuthorization(DOMAIN, 'https://console.test.invalid');

    expect(writes()).toStrictEqual([TENANT_SETTINGS_WRITE]);
  });

  it('fails when the tenant is not entitled to CIMD registration', async () => {
    stubTenant({ resourceServerStatus: 200, connections: [] });
    const answerTenant = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url, init) =>
      url === `${API}/tenants/settings`
        ? new Response('not_entitled', { status: 403 })
        : answerTenant(url, init),
    );

    await expect(
      setupAuth0McpAuthorization(DOMAIN, 'https://console.test.invalid'),
    ).rejects.toThrow('Auth0 update tenant settings failed');
  });

  it('fails when Auth0 refuses to read the MCP API', async () => {
    stubTenant({ resourceServerStatus: 403, connections: [] });

    await expect(
      setupAuth0McpAuthorization(DOMAIN, 'https://console.test.invalid'),
    ).rejects.toThrow('Auth0 get MCP resource server failed');
  });
});
