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
import { S3Client, CreateBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import QuickLRU from 'quick-lru';
import { Resource } from 'sst';
import { S3Region } from '@filone/shared';
import { getDynamoClient } from '../ddb-client.js';
import { ensureTenantReady as ensureFthTenantReady } from './fth-tenant-setup.js';
import { BucketAlreadyExistsError, NotImplementedError } from '../service-orchestrator.js';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  PresignerContext,
  ServiceOrchestrator,
} from '../service-orchestrator.js';

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

export const fthOrchestrator: ServiceOrchestrator = {
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
    const credentials = await getFthS3Credentials(tenantId);
    return {
      endpointUrl: process.env.FTH_S3_URL!,
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
    };
  },

  async createBucket(tenantId: string, args: CreateBucketArgs): Promise<void> {
    if (args.lock) {
      throw new Error('FTH does not support object lock on bucket creation');
    }
    if (args.retention?.enabled) {
      throw new Error('FTH does not support default retention on bucket creation');
    }
    if (args.versioning) {
      throw new Error('FTH does not support bucket versioning on creation');
    }

    const ctx = await this.getPresignerContext(tenantId);
    const s3 = createS3ClientFor(ctx);
    try {
      const result = await s3.send(new CreateBucketCommand({ Bucket: args.bucketName }));
      console.log('CreateBucket result:', result);
    } catch (err) {
      console.log('CreateBucket error:', err);
      const name = (err as { name?: string }).name;
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
        throw new BucketAlreadyExistsError(args.bucketName, { cause: err as Error });
      }
      throw err;
    }
  },

  async deleteBucket(_tenantId: string, _bucketName: string): Promise<void> {
    throw new NotImplementedError('Bucket deletion is not implemented in this region yet');
  },

  async listBuckets(tenantId: string): Promise<BucketSummary[]> {
    const ctx = await this.getPresignerContext(tenantId);
    const s3 = createS3ClientFor(ctx);
    // TODO: handle pagination if a tenant has many buckets.
    const result = await s3.send(new ListBucketsCommand({}));
    return (result.Buckets ?? [])
      .filter((b): b is typeof b & { Name: string } => !!b.Name)
      .map((b) => ({
        name: b.Name,
        region: this.region,
        createdAt: b.CreationDate?.toISOString() ?? new Date().toISOString(),
        isPublic: false,
        versioning: false,
        encrypted: true,
      }));
  },

  async getBucket(_tenantId: string, bucketName: string): Promise<BucketDetails | null> {
    // TODO: replace with a real implementation
    return {
      name: bucketName,
      region: this.region,
      createdAt: new Date().toISOString(),
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
};

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

function createS3ClientFor(ctx: PresignerContext): S3Client {
  return new S3Client({
    endpoint: ctx.endpointUrl,
    region: ctx.region,
    credentials: ctx.credentials,
    forcePathStyle: ctx.forcePathStyle,
  });
}
