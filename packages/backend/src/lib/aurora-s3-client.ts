import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

export interface AuroraS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export async function getAuroraS3Credentials(
  stage: string,
  tenantId: string,
): Promise<AuroraS3Credentials> {
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

  return JSON.parse(value) as AuroraS3Credentials;
}

export async function getPresignedPutUrl(
  endpointUrl: string,
  credentials: AuroraS3Credentials,
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  const s3 = new S3Client({
    endpoint: endpointUrl,
    region: 'auto',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });

  console.log('[aurora-s3] Creating presigned PUT URL', {
    endpoint: endpointUrl,
    bucket,
    key,
    accessKeyId: credentials.accessKeyId,
    expiresIn,
  });

  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn },
  );
}
