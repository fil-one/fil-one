import assert from 'node:assert';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  createClient,
  getTenantsByTenantIdAccessKeys,
  getTenantsByTenantIdAccessKeysByAccessKeyId,
  postTenantsByTenantIdBucket,
  putTenantsByTenantIdAccessKeys,
} from '@filone/aurora-portal-client';

const ssm = new SSMClient({});

export class DuplicateKeyNameError extends Error {
  constructor() {
    super('An access key with this name already exists');
    this.name = 'DuplicateKeyNameError';
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

  const { error, response } = await postTenantsByTenantIdBucket({
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

export interface CreateAuroraAccessKeyOptions {
  tenantId: string;
  keyName: string;
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
}: CreateAuroraAccessKeyOptions): Promise<CreateAuroraAccessKeyResult> {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { data, error, response } = await putTenantsByTenantIdAccessKeys({
    client,
    path: { tenantId },
    body: {
      name: keyName,
      access: [
        'Default',
        'Read',
        'Write',
        'Delete',
        'List',
        'GetBucketVersioning',
        'GetBucketObjectLockConfiguration',
        'ListBucketVersions',
        'GetObjectVersion',
        'GetObjectRetention',
        'GetObjectLegalHold',
        'PutObjectRetention',
        'PutObjectLegalHold',
        'DeleteObjectVersion',
      ],
    },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 409) {
      throw new DuplicateKeyNameError();
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
}: CreateAuroraAccessKeyOptions): Promise<FindAuroraAccessKeyResult | undefined> {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  // Step 1: List all access keys and find by name
  const { data: listData, error: listError } = await getTenantsByTenantIdAccessKeys({
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
    await getTenantsByTenantIdAccessKeysByAccessKeyId({
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
