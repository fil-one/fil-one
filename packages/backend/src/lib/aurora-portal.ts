import assert from 'node:assert';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import QuickLRU from 'quick-lru';
import {
  createClient,
  createBucket,
  createS3AccessKey,
  deleteS3AccessKey,
  getS3AccessKey,
  listS3AccessKeys,
} from '@filone/aurora-portal-client';
import type {
  AccessKeyPermission,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
} from '@filone/shared';
import { instrumentClient } from './aurora-api-metrics.js';

const ssm = new SSMClient({});
const ssmCache = new QuickLRU<string, string>({ maxSize: 500 });
export const _resetSsmCacheForTesting = () => ssmCache.clear();

export class BucketAlreadyExistsError extends Error {
  constructor(bucketName: string) {
    super(`Bucket "${bucketName}" already exists`);
    this.name = 'BucketAlreadyExistsError';
  }
}

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

async function createPortalClient(tenantId: string) {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });
  instrumentClient(client, { apiName: 'aurora-portal' });

  return client;
}

export interface CreateAuroraBucketOptions {
  tenantId: string;
  bucketName: string;
  versioning?: boolean;
  lock?: boolean;
  retention?: {
    enabled: boolean;
    mode: RetentionMode;
    duration: number;
    durationType: RetentionDurationType;
  };
}

export async function createAuroraBucket({
  tenantId,
  bucketName,
  versioning,
  lock,
  retention,
}: CreateAuroraBucketOptions): Promise<void> {
  const client = await createPortalClient(tenantId);

  const { error, response } = await createBucket({
    client,
    path: { tenantId },
    body: {
      name: bucketName,
      encrypted: true,
      ...(versioning ? { versioning: true } : {}),
      ...(lock ? { lock: true } : {}),
      ...(retention?.enabled
        ? {
            defaultRetention: {
              enabled: true,
              mode: retention.mode,
              duration: {
                duration: retention.duration,
                type: retention.durationType,
              },
            },
          }
        : {}),
    },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 409) {
      throw new BucketAlreadyExistsError(bucketName);
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

// Maps basic permissions to their base Aurora access type.
const AURORA_BASE_ACTION: Record<AccessKeyPermission, string> = {
  read: 'Read',
  write: 'Write',
  list: 'List',
  delete: 'Delete',
};

export function buildAuroraAccessArray(
  permissions: AccessKeyPermission[],
  granularPermissions?: GranularPermission[],
): string[] {
  const base = permissions.map((p) => AURORA_BASE_ACTION[p]);
  const granular = granularPermissions ?? [];
  return [...AURORA_ACCESS_ALWAYS, ...base, ...granular];
}

export interface CreateAuroraAccessKeyOptions {
  tenantId: string;
  keyName: string;
  permissions: AccessKeyPermission[];
  granularPermissions?: GranularPermission[];
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
  granularPermissions,
  buckets,
  expiresAt,
}: CreateAuroraAccessKeyOptions): Promise<CreateAuroraAccessKeyResult> {
  const client = await createPortalClient(tenantId);

  const { data, error, response } = await createS3AccessKey({
    client,
    path: { tenantId },
    body: {
      name: keyName,
      access: buildAuroraAccessArray(permissions, granularPermissions),
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
  assert(!!id, `Aurora Portal API returned empty access key "id" for tenant ${tenantId}`);
  assert(
    !!accessKeyId,
    `Aurora Portal API returned empty access key "accessKeyId" for tenant ${tenantId}. Response fields: ${Object.keys(data).join(', ')}`,
  );
  assert(
    !!accessKeySecret,
    `Aurora Portal API returned empty access key "accessKeySecret" for tenant ${tenantId}. Response fields: ${Object.keys(data).join(', ')}`,
  );
  assert(
    !!createdAt,
    `Aurora Portal API returned empty access key "createdAt" for tenant ${tenantId}. Response fields: ${Object.keys(data).join(', ')}`,
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
  const client = await createPortalClient(tenantId);

  // Step 1: List all access keys and find by name
  const { data: listData, error: listError } = await listS3AccessKeys({
    client,
    path: { tenantId },
    throwOnError: false,
  });

  if (listError) {
    throw new Error(`Failed to list Aurora access keys for tenant ${tenantId}`, {
      cause: listError,
    });
  }

  const keys = listData?.items ?? [];
  const match = keys.find((k: { name?: string }) => k.name === keyName);
  if (!match) {
    return undefined;
  }

  assert(
    !!match.id,
    `Aurora list access keys returned empty "id" for key "${keyName}" in tenant ${tenantId}. Full response: ${JSON.stringify(listData)}`,
  );

  // Step 2: Get full details by internal ID (list doesn't include accessKeyId)
  const { data: detailData, error: detailError } = await getS3AccessKey({
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
  const client = await createPortalClient(tenantId);

  const { error, response } = await deleteS3AccessKey({
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
  const cacheKey = `${stage}/${tenantId}`;
  const cached = ssmCache.get(cacheKey);
  if (cached) return cached;

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

  ssmCache.set(cacheKey, apiKey);
  return apiKey;
}
