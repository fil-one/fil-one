import { S3Client, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import QuickLRU from 'quick-lru';

const ssm = new SSMClient({});
const ssmCache = new QuickLRU<string, string>({ maxSize: 500 });
export const _resetSsmCacheForTesting = () => ssmCache.clear();

export interface AuroraS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function createS3Client(endpointUrl: string, credentials: AuroraS3Credentials): S3Client {
  return new S3Client({
    endpoint: endpointUrl,
    region: 'auto',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

export async function getAuroraS3Credentials(
  stage: string,
  tenantId: string,
): Promise<AuroraS3Credentials> {
  const cacheKey = `${stage}/${tenantId}`;
  const cached = ssmCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as AuroraS3Credentials;

  let value: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({
        Name: `/filone/${stage}/aurora-s3/access-key/${tenantId}`,
        WithDecryption: true,
      }),
    );
    value = Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      throw new Error(`Aurora S3 credentials not found in SSM for tenant ${tenantId}`);
    }
    throw err;
  }

  if (!value) {
    throw new Error(`Aurora S3 credentials not found in SSM for tenant ${tenantId}`);
  }

  ssmCache.set(cacheKey, value);
  return JSON.parse(value) as AuroraS3Credentials;
}

export async function deleteBucket(
  endpointUrl: string,
  credentials: AuroraS3Credentials,
  bucket: string,
): Promise<void> {
  const s3 = createS3Client(endpointUrl, credentials);
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}
