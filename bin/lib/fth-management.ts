// Talking to the FTH management API from a script.
//
// The backend has a full client (packages/backend/src/lib/fth/fth-management-client.ts),
// and bin scripts must not import from the backend, so this is the small part
// the key scripts need: the transport, the four access-key endpoints and the
// storage-user lookup. Keep the paths in sync with the backend client.
//
// `getAccessKey` is what separates a key FTH does not have from one it merely
// leaves out of the listing, so the transport raises a typed error carrying the
// HTTP status rather than a formatted string.

export interface FthStorageUser {
  id: string;
  userCode: string;
}

export interface FthAccessKey {
  id?: string;
  accessKeyId: string;
  name: string;
  permissions: string[];
}

export interface FthAccessKeyWithSecret extends FthAccessKey {
  secretAccessKey: string;
}

export interface CreateAccessKeyArgs {
  name: string;
  permissions: string[];
  idempotencyKey: string;
}

export class FthHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FthHttpError';
    this.status = status;
  }
}

export interface FthManagementApi {
  listStorageUsers(tenantId: string): Promise<FthStorageUser[]>;
  listAccessKeys(tenantId: string): Promise<FthAccessKey[]>;
  /** False only on a 404 — every other failure throws. */
  accessKeyExists(tenantId: string, accessKeyId: string): Promise<boolean>;
  createAccessKey(
    tenantId: string,
    userId: string,
    args: CreateAccessKeyArgs,
  ): Promise<FthAccessKeyWithSecret>;
  deleteAccessKey(tenantId: string, accessKeyId: string): Promise<void>;
}

export function createFthManagementApi(config: {
  baseUrl: string;
  token: string;
}): FthManagementApi {
  const clientPath = (tenantId: string) => `/management/v1/clients/${encodeURIComponent(tenantId)}`;

  async function request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new FthHttpError(
        response.status,
        `FTH ${method} ${path} → ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    async listStorageUsers(tenantId) {
      const users = await request<{ items?: FthStorageUser[] }>(
        'GET',
        `${clientPath(tenantId)}/storage-users`,
      );
      return users.items ?? [];
    },

    async listAccessKeys(tenantId) {
      const keys = await request<{ items?: FthAccessKey[] }>(
        'GET',
        `${clientPath(tenantId)}/access-keys`,
      );
      return keys.items ?? [];
    },

    async accessKeyExists(tenantId, accessKeyId) {
      try {
        await request<FthAccessKey>(
          'GET',
          `${clientPath(tenantId)}/access-keys/${encodeURIComponent(accessKeyId)}`,
        );
        return true;
      } catch (err) {
        if (err instanceof FthHttpError && err.status === 404) return false;
        throw err;
      }
    },

    createAccessKey(tenantId, userId, args) {
      return request<FthAccessKeyWithSecret>(
        'POST',
        `${clientPath(tenantId)}/storage-users/${encodeURIComponent(userId)}/access-keys`,
        {
          body: {
            name: args.name,
            permissions: args.permissions,
            buckets: [],
            expiresAt: null,
          },
          idempotencyKey: args.idempotencyKey,
        },
      );
    },

    // FTH addresses a key by its accessKeyId; `id` is present on some responses
    // and is the same value.
    deleteAccessKey(tenantId, accessKeyId) {
      return request<void>(
        'DELETE',
        `${clientPath(tenantId)}/access-keys/${encodeURIComponent(accessKeyId)}`,
      );
    },
  };
}
