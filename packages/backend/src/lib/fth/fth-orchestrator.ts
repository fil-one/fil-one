// Fortilyx (FTH) backed ServiceOrchestrator.
//
// The interface methods are intentionally split into two layers:
//   - control-plane (ensureTenantReady, isTenantReady, issueAccessKey, ...)
//     call the FTH management REST API. ensureTenantReady delegates to
//     fth-tenant-setup.ts; the other control-plane methods live here.
//   - data-plane (createBucket, deleteBucket, listBuckets, getBucket,
//     getPresignerContext) speak S3 directly against the FTH S3 endpoint
//     using the service access key stashed in SSM during setup.

import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import QuickLRU from 'quick-lru';
import { Resource } from 'sst';
import { getS3Endpoint, S3Region } from '@filone/shared';
import { getDynamoClient } from '../ddb-client.js';
import { ensureTenantReady as ensureFthTenantReady } from './fth-tenant-setup.js';
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

import { createBucket as s3CreateBucket, listBuckets as s3ListBuckets } from '../s3-presigner.js';

interface FthS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const dynamo = getDynamoClient();
const ssm = new SSMClient({});
const ssmCache = new QuickLRU<string, string>({ maxSize: 500 });

export const _resetFthOrchestratorCachesForTesting = () => {
  ssmCache.clear();
};

export const fthOrchestrator = {
  id: 'fth',
  region: S3Region.UsEast1,

  async ensureTenantReady(orgId: string): Promise<string | null> {
    return ensureFthTenantReady(orgId);
  },

  async isTenantReady(orgId: string): Promise<string | null> {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
        ConsistentRead: true,
      }),
    );
    const tenantId = Item?.fthTenantId?.S;
    if (!tenantId) return null;
    // TODO: check fthTenantSetupStatus
    return tenantId;
  },

  async getPresignerContext(tenantId: string): Promise<PresignerContext> {
    const stage = process.env.FILONE_STAGE!;
    const credentials = await getFthS3Credentials(tenantId);
    return {
      endpointUrl: getS3Endpoint(fthOrchestrator.region, stage),
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
    };
  },

  async createBucket(tenantId: string, args: CreateBucketArgs): Promise<void> {
    if (args.lock) {
      throw new NotImplementedError(
        'Object lock on bucket creation is not supported in this region yet',
      );
    }
    if (args.retention?.enabled) {
      throw new NotImplementedError(
        'Retention policy on bucket creation is not supported in this region yet',
      );
    }
    if (args.versioning) {
      throw new NotImplementedError(
        'Versioning on bucket creation is not supported in this region yet',
      );
    }

    const ctx = await fthOrchestrator.getPresignerContext(tenantId);
    await s3CreateBucket(ctx, { bucketName: args.bucketName });
  },

  async deleteBucket(_tenantId: string, _bucketName: string): Promise<void> {
    throw new NotImplementedError('Bucket deletion is not implemented in this region yet');
  },

  async listBuckets(tenantId: string): Promise<BucketSummary[]> {
    const ctx = await fthOrchestrator.getPresignerContext(tenantId);
    const { buckets } = await s3ListBuckets(ctx);
    return buckets.map((b) => ({
      bucketName: b.name,
      region: fthOrchestrator.region,
      createdAt: b.createdAt,
      isPublic: false,
      versioning: false,
      encrypted: true,
    }));
  },

  async getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null> {
    const ctx = await fthOrchestrator.getPresignerContext(tenantId);
    const { buckets } = await s3ListBuckets(ctx);
    const match = buckets.find((b) => b.name === bucketName);
    if (!match) return null;

    return {
      bucketName,
      region: fthOrchestrator.region,
      createdAt: match.createdAt,
      isPublic: false,
      versioning: false,
      encrypted: true,
    };
  },

  async issueAccessKey(_tenantId: string, _opts: IssueAccessKeyOpts): Promise<IssuedAccessKey> {
    throw new NotImplementedError('Access key management is not implemented in this region yet');
  },

  async findAccessKeyByName(_tenantId: string, _keyName: string) {
    throw new NotImplementedError('Access key management is not implemented in this region yet');
  },
} satisfies ServiceOrchestrator;

async function getFthS3Credentials(tenantId: string): Promise<FthS3Credentials> {
  const stage = process.env.FILONE_STAGE!;
  const cacheKey = `${stage}/${tenantId}`;
  const cached = ssmCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as FthS3Credentials;

  let value: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({
        Name: `/filone/${stage}/fth-s3/access-key/${tenantId}`,
        WithDecryption: true,
      }),
    );
    value = Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      throw new Error(`FTH S3 credentials not found in SSM for tenant ${tenantId}`, { cause: err });
    }
    throw err;
  }

  if (!value) {
    throw new Error(`FTH S3 credentials not found in SSM for tenant ${tenantId}`);
  }

  ssmCache.set(cacheKey, value);
  return JSON.parse(value) as FthS3Credentials;
}
