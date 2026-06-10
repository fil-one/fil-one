// Aurora-backed ServiceOrchestrator. Delegates to the existing per-call modules
// (aurora-tenant-setup for the lazy setup state machine, aurora-portal for
// bucket and access-key ops) and looks up SSM-cached S3 credentials directly.
//
// PROFILE-row attributes used: `auroraTenantId` and `auroraSetupStatus`.

import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { S3Region, getS3Endpoint } from '@filone/shared';
import type {
  AccessKeyPermission,
  Bucket,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
  S3Region as S3RegionType,
} from '@filone/shared';
import { createClient, getBucketInfo, listBuckets } from '@filone/aurora-portal-client';
import { ensureTenantReady as ensureAuroraTenantReady } from '../aurora/aurora-tenant-setup.js';
import {
  createAuroraAccessKey,
  createAuroraBucket,
  deleteAuroraAccessKey,
  findAuroraAccessKeyByName,
  getAuroraPortalApiKey,
} from '../aurora/aurora-portal.js';
import { getDynamoClient } from '../ddb-client.js';
import { isOrgSetupComplete } from '../org-setup-status.js';
import { getConsoleS3Credentials, _resetS3CredentialsCacheForTesting } from '../s3-credentials.js';
import { NotImplementedError } from '../errors.js';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  PresignerContext,
  ServiceOrchestrator,
} from '../service-orchestrator.js';

const dynamo = getDynamoClient();
export const _resetSsmCacheForTesting = () => _resetS3CredentialsCacheForTesting();

function getStage(): string {
  return process.env.FILONE_STAGE!;
}

function getPortalBaseUrl(): string {
  return process.env.AURORA_PORTAL_URL!;
}

async function createPortalReadClient(tenantId: string) {
  const apiKey = await getAuroraPortalApiKey(getStage(), tenantId);
  return createClient({
    baseUrl: getPortalBaseUrl(),
    headers: { 'X-Api-Key': apiKey },
  });
}

export const auroraOrchestrator = {
  id: 'aurora',
  region: S3Region.EuWest1 as S3RegionType,

  async ensureTenantReady(orgId): Promise<string | null> {
    const result = await ensureAuroraTenantReady(orgId);
    if (result.ok) return result.auroraTenantId;
    return null;
  },

  async isTenantReady(orgId): Promise<string | null> {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
        ProjectionExpression: 'auroraTenantId, auroraSetupStatus',
      }),
    );
    const tenantId = Item?.auroraTenantId?.S;
    if (!tenantId) return null;
    if (!isOrgSetupComplete(Item?.auroraSetupStatus?.S)) return null;
    return tenantId;
  },

  async createBucket(tenantId: string, args: CreateBucketArgs): Promise<void> {
    await createAuroraBucket({
      tenantId,
      bucketName: args.bucketName,
      versioning: args.versioning,
      lock: args.lock,
      retention: args.retention as
        | {
            enabled: boolean;
            mode: RetentionMode;
            duration: number;
            durationType: RetentionDurationType;
          }
        | undefined,
    });
  },

  async deleteBucket(_tenantId: string, _bucketName: string): Promise<void> {
    // TODO: Implement bucket deletion.
    // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
    throw new NotImplementedError('Aurora bucket deletion is not yet supported. See FIL-204.');
  },

  async listBuckets(tenantId: string): Promise<BucketSummary[]> {
    const client = await createPortalReadClient(tenantId);
    const { data, error } = await listBuckets({
      client,
      path: { tenantId },
      throwOnError: false,
    });

    if (error) {
      throw new Error(`Failed to list buckets from Aurora for tenant ${tenantId}`, {
        cause: error,
      });
    }

    return (data?.items ?? [])
      .filter((b): b is typeof b & { name: string; createdAt: string } => !!b.name && !!b.createdAt)
      .map((b) => ({
        bucketName: b.name,
        region: auroraOrchestrator.region,
        createdAt: b.createdAt,
        isPublic: false,
        versioning: b.flags?.includes('versioned') ?? false,
        encrypted: b.flags?.includes('encrypted') ?? true,
      }));
  },

  async getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null> {
    const client = await createPortalReadClient(tenantId);
    const { data, error, response } = await getBucketInfo({
      client,
      path: { tenantId, bucketName },
      throwOnError: false,
    });

    if (error) {
      if (response?.status === 404) return null;
      throw new Error(`Failed to get bucket "${bucketName}" from Aurora for tenant ${tenantId}`, {
        cause: error,
      });
    }

    if (!data?.createdAt) {
      throw new Error(
        `Aurora returned incomplete data for bucket "${bucketName}" (tenant ${tenantId})`,
      );
    }

    const defaultRetention =
      data.defaultRetention && data.defaultRetention !== 'off'
        ? (data.defaultRetention as Bucket['defaultRetention'])
        : undefined;

    return {
      bucketName: data.name ?? bucketName,
      region: auroraOrchestrator.region,
      createdAt: data.createdAt,
      isPublic: false,
      objectLockEnabled: data.objectLock ?? false,
      versioning: data.versioning ?? false,
      encrypted: data.encrypted ?? true,
      defaultRetention,
      retentionDuration: data.retentionDuration ?? undefined,
      retentionDurationType:
        (data.retentionDurationType as RetentionDurationType | undefined) ?? undefined,
    };
  },

  async issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey> {
    const key = await createAuroraAccessKey({
      tenantId,
      keyName: opts.keyName,
      permissions: opts.permissions as AccessKeyPermission[],
      granularPermissions: opts.granularPermissions as GranularPermission[] | undefined,
      buckets: opts.buckets,
      expiresAt: opts.expiresAt,
    });
    return {
      id: key.id,
      accessKeyId: key.accessKeyId,
      accessKeySecret: key.accessKeySecret,
      createdAt: key.createdAt,
    };
  },

  async findAccessKeyByName(tenantId: string, keyName: string) {
    return findAuroraAccessKeyByName({ tenantId, keyName });
  },

  async deleteAccessKey(tenantId: string, keyId: string): Promise<void> {
    await deleteAuroraAccessKey({ tenantId, auroraKeyId: keyId });
  },

  async getPresignerContext(tenantId: string): Promise<PresignerContext> {
    const stage = getStage();
    const credentials = await getConsoleS3Credentials({
      orchestratorId: auroraOrchestrator.id,
      stage,
      tenantId,
    });
    return {
      endpointUrl: getS3Endpoint(S3Region.EuWest1, stage),
      region: 'auto',
      credentials,
      forcePathStyle: true,
    };
  },
} satisfies ServiceOrchestrator;
