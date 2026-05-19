// Auth0 passkey-on-primary-connection setup. Extracted from
// setup-integrations.ts to keep that file under the max-lines lint cap.

const PASSKEY_CONNECTION_NAME = 'Username-Password-Authentication';

interface Auth0Connection {
  id: string;
  name: string;
  strategy: string;
  options?: Record<string, unknown>;
}

interface PasskeyOptions {
  authentication_methods?: {
    passkey?: { enabled?: boolean };
    password?: { enabled?: boolean };
  };
  passkey_options?: {
    progressive_enrollment_enabled?: boolean;
    local_enrollment_enabled?: boolean;
    challenge_ui?: string;
  };
}

const DESIRED_PASSKEY_OPTIONS: Required<PasskeyOptions> = {
  authentication_methods: {
    passkey: { enabled: true },
    password: { enabled: true },
  },
  passkey_options: {
    progressive_enrollment_enabled: true,
    local_enrollment_enabled: true,
    challenge_ui: 'both',
  },
};

function passkeyShapeMatches(existing: PasskeyOptions | undefined): boolean {
  const methods = existing?.authentication_methods;
  const opts = existing?.passkey_options;
  return (
    methods?.passkey?.enabled === true &&
    methods?.password?.enabled === true &&
    opts?.progressive_enrollment_enabled === true &&
    opts?.local_enrollment_enabled === true &&
    opts?.challenge_ui === 'both'
  );
}

async function throwIfNotOk(resp: Response, label: string): Promise<void> {
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${label} (${resp.status}): ${body}`);
  }
}

/**
 * Enable passkeys on the primary database connection, idempotently. The full
 * `options` object is merged so other connection fields (password policy,
 * brute-force protection, etc.) are preserved through the PATCH.
 */
export async function setupAuth0PasskeyAuth(domain: string, token: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const listResp = await fetch(
    `https://${domain}/api/v2/connections?strategy=auth0&name=${encodeURIComponent(PASSKEY_CONNECTION_NAME)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  await throwIfNotOk(listResp, 'Auth0 list connections failed');

  const connections = (await listResp.json()) as Auth0Connection[];
  const connection = connections.find((c) => c.name === PASSKEY_CONNECTION_NAME);
  if (!connection) {
    throw new Error(`Auth0 connection ${PASSKEY_CONNECTION_NAME} not found`);
  }

  const getResp = await fetch(`https://${domain}/api/v2/connections/${connection.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await throwIfNotOk(getResp, 'Auth0 get connection failed');

  const full = (await getResp.json()) as Auth0Connection;
  const existingOptions = (full.options ?? {}) as PasskeyOptions & Record<string, unknown>;

  if (passkeyShapeMatches(existingOptions)) return;

  const mergedOptions = {
    ...existingOptions,
    authentication_methods: {
      ...(existingOptions.authentication_methods ?? {}),
      ...DESIRED_PASSKEY_OPTIONS.authentication_methods,
    },
    passkey_options: {
      ...(existingOptions.passkey_options ?? {}),
      ...DESIRED_PASSKEY_OPTIONS.passkey_options,
    },
  };

  const patchResp = await fetch(`https://${domain}/api/v2/connections/${connection.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ options: mergedOptions }),
  });
  await throwIfNotOk(patchResp, 'Auth0 update connection (passkey) failed');
}
