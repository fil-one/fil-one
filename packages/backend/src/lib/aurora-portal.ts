import assert from 'node:assert';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  createClient,
  deleteV1TenantsByTenantIdAccessKeysByAccessKeyId,
  getV1TenantsByTenantIdAccessKeys,
  getV1TenantsByTenantIdAccessKeysByAccessKeyId,
  postV1TenantsByTenantIdAccessKeys,
  postV1TenantsByTenantIdBucket,
} from '@filone/aurora-portal-client';
import type { AccessKeyPermission } from '@filone/shared';

const ssm = new SSMClient({});

export class DuplicateKeyNameError extends Error {
  constructor() {
    super('An access key with this name already exists');
    this.name = 'DuplicateKeyNameError';
  }
}

export class AuroraValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuroraValidationError';
  }
}

export interface CreateAuroraBucketOptions {
  tenantId: string;
  bucketName: string;
}

export async function createAuroraBucket({
  tenantId,
  bucketName,
}: CreateAuroraBucketOptions): Promise<void> {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { error, response } = await postV1TenantsByTenantIdBucket({
    client,
    path: { tenantId },
    body: { name: bucketName },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 409) {
      console.log(
        `Aurora bucket "${bucketName}" already exists for tenant ${tenantId}, treating as success`,
      );
      return;
    }
    throw new Error(`Failed to create Aurora bucket "${bucketName}" for tenant ${tenantId}`, {
      cause: error,
    });
  }

  console.log(`Aurora bucket "${bucketName}" created for tenant ${tenantId}`);
}

// Always-included Aurora access types required for Object Lock / versioning.
const AURORA_ACCESS_ALWAYS: string[] = [
  'Default',
  'GetBucketVersioning',
  'GetBucketObjectLockConfiguration',
];

// Maps our permission model to Aurora access type strings.
const AURORA_ACCESS_MAP: Record<AccessKeyPermission, string[]> = {
  read: ['Read', 'GetObjectVersion', 'GetObjectRetention', 'GetObjectLegalHold'],
  write: ['Write', 'PutObjectRetention', 'PutObjectLegalHold'],
  list: ['List', 'ListBucketVersions'],
  delete: ['Delete', 'DeleteObjectVersion'],
};

export function buildAuroraAccessArray(permissions: AccessKeyPermission[]): string[] {
  const extra = permissions.flatMap((p) => AURORA_ACCESS_MAP[p]);
  return [...AURORA_ACCESS_ALWAYS, ...extra];
}

export interface CreateAuroraAccessKeyOptions {
  tenantId: string;
  keyName: string;
  permissions: AccessKeyPermission[];
  buckets?: string[];
  expiresAt?: string | null;
}
export interface CreateAuroraAccessKeyResult {
  id: string;
  accessKeyId: string;
  accessKeySecret: string;
  createdAt: string;
}

export async function createAuroraAccessKey({
  tenantId,
  keyName,
  permissions,
  buckets,
  expiresAt,
}: CreateAuroraAccessKeyOptions): Promise<CreateAuroraAccessKeyResult> {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { data, error, response } = await postV1TenantsByTenantIdAccessKeys({
    client,
    path: { tenantId },
    body: {
      name: keyName,
      access: buildAuroraAccessArray(permissions),
      ...(buckets && buckets.length > 0 ? { buckets } : {}),
      ...(expiresAt ? { expiration: expiresAt } : {}),
    },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 409) {
      throw new DuplicateKeyNameError();
    }
    if (response?.status === 400) {
      const detail =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: string }).message)
          : undefined;
      throw new AuroraValidationError(
        detail ?? 'Invalid access key request. Check the key name and try again.',
      );
    }
    console.error(
      `Aurora access key creation failed for tenant ${tenantId}:`,
      JSON.stringify(error),
    );
    throw new Error(`Failed to create Aurora access key "${keyName}" for tenant ${tenantId}`, {
      cause: error,
    });
  }

  const accessKey = data?.accessKey;
  assert(
    typeof accessKey === 'object' && accessKey !== null,
    `Aurora API returned invalid access key for tenant ${tenantId}: expected an object but got ${typeof accessKey}`,
  );
  const { id, accessKeyId, accessKeySecret, createdAt } = accessKey;
  assert(
    !!id,
    `Aurora Portal API returned empty access key "id" for tenant ${tenantId}. Full response: ${JSON.stringify(data)}`,
  );
  assert(
    !!accessKeyId,
    `Aurora Portal API returned empty access key "accessKeyId" for tenant ${tenantId}. Full response: ${JSON.stringify(data)}`,
  );
  assert(
    !!accessKeySecret,
    `Aurora Portal API returned empty access key "accessKeySecret" for tenant ${tenantId}. Full response: ${JSON.stringify(data)}`,
  );
  assert(
    !!createdAt,
    `Aurora Portal API returned empty access key "createdAt" for tenant ${tenantId}. Full response: ${JSON.stringify(data)}`,
  );

  console.log(
    `Aurora access key "${keyName}" created for tenant ${tenantId}: accessKeyId=${accessKeyId}, createdAt=${createdAt}`,
  );
  return { id, accessKeyId, accessKeySecret, createdAt };
}

export interface FindAuroraAccessKeyResult {
  id: string;
  accessKeyId: string;
  createdAt: string;
}

export async function findAuroraAccessKeyByName({
  tenantId,
  keyName,
}: {
  tenantId: string;
  keyName: string;
}): Promise<FindAuroraAccessKeyResult | undefined> {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  // Step 1: List all access keys and find by name
  const { data: listData, error: listError } = await getV1TenantsByTenantIdAccessKeys({
    client,
    path: { tenantId },
    throwOnError: false,
  });

  if (listError) {
    throw new Error(`Failed to list Aurora access keys for tenant ${tenantId}`, {
      cause: listError,
    });
  }

  const keys = listData?.accessKeys ?? [];
  const match = keys.find((k: { name?: string }) => k.name === keyName);
  if (!match) {
    return undefined;
  }

  assert(
    !!match.id,
    `Aurora list access keys returned empty "id" for key "${keyName}" in tenant ${tenantId}. Full response: ${JSON.stringify(listData)}`,
  );

  // Step 2: Get full details by internal ID (list doesn't include accessKeyId)
  const { data: detailData, error: detailError } =
    await getV1TenantsByTenantIdAccessKeysByAccessKeyId({
      client,
      path: { tenantId, accessKeyId: match.id },
      throwOnError: false,
    });

  if (detailError) {
    throw new Error(`Failed to get Aurora access key "${match.id}" for tenant ${tenantId}`, {
      cause: detailError,
    });
  }

  const accessKey = detailData?.accessKey;
  assert(
    typeof accessKey === 'object' && accessKey !== null,
    `Aurora API returned invalid access key detail for tenant ${tenantId}: expected an object but got ${typeof accessKey}`,
  );
  assert(
    !!accessKey.id,
    `Aurora API returned empty "id" in access key detail for tenant ${tenantId}. Full response: ${JSON.stringify(detailData)}`,
  );
  assert(
    !!accessKey.accessKeyId,
    `Aurora API returned empty "accessKeyId" in access key detail for tenant ${tenantId}. Full response: ${JSON.stringify(detailData)}`,
  );
  assert(
    !!accessKey.createdAt,
    `Aurora API returned empty "createdAt" in access key detail for tenant ${tenantId}. Full response: ${JSON.stringify(detailData)}`,
  );

  return {
    id: accessKey.id,
    accessKeyId: accessKey.accessKeyId,
    createdAt: accessKey.createdAt,
  };
}

export async function deleteAuroraAccessKey({
  tenantId,
  auroraKeyId,
}: {
  tenantId: string;
  auroraKeyId: string;
}): Promise<void> {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { error, response } = await deleteV1TenantsByTenantIdAccessKeysByAccessKeyId({
    client,
    path: { tenantId, accessKeyId: auroraKeyId },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 404) {
      // Already deleted — treat as success
      console.log(
        `Aurora access key "${auroraKeyId}" not found for tenant ${tenantId}, treating as already deleted`,
      );
      return;
    }
    throw new Error(`Failed to delete Aurora access key "${auroraKeyId}" for tenant ${tenantId}`, {
      cause: error,
    });
  }

  console.log(`Aurora access key "${auroraKeyId}" deleted for tenant ${tenantId}`);
}

export async function getAuroraPortalApiKey(stage: string, tenantId: string): Promise<string> {
  let apiKey: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({
        Name: `/filone/${stage}/aurora-portal/tenant-api-key/${tenantId}`,
        WithDecryption: true,
      }),
    );
    apiKey = Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      throw new Error(`Aurora API key not found in SSM for tenant ${tenantId}`);
    }
    throw err;
  }

  if (!apiKey) {
    throw new Error(`Aurora API key not found in SSM for tenant ${tenantId}`);
  }

  return apiKey;
}
