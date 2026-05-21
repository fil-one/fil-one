// Shared SSM-cached lookup of per-tenant S3 access keys for the
// ServiceOrchestrator implementations (FTH, Aurora, ...). Each orchestrator
// stashes its tenant's S3 credentials at
//   /filone/<stage>/<orchestratorId>-s3/access-key/<tenantId>
// during tenant setup; this helper centralises the cache + decryption +
// error translation so adding a third orchestrator does not require
// re-implementing the lookup.

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import QuickLRU from 'quick-lru';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface GetConsoleS3CredentialsArgs {
  // ServiceOrchestrator.id — drives the SSM path segment
  // (`${orchestratorId}-s3`) and the error-message label.
  orchestratorId: string;
  stage: string;
  tenantId: string;
}

const ssm = new SSMClient({});
const ssmCache = new QuickLRU<string, string>({ maxSize: 500 });

export const _resetS3CredentialsCacheForTesting = () => ssmCache.clear();

export async function getServiceS3Credentials(
  args: GetConsoleS3CredentialsArgs,
): Promise<S3Credentials> {
  const { orchestratorId, stage, tenantId } = args;
  // Include orchestratorId in the cache key so providers sharing this LRU
  // don't collide on the same (stage, tenantId).
  const cacheKey = `${stage}/${orchestratorId}/${tenantId}`;
  const cached = ssmCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as S3Credentials;

  const parameterName = `/filone/${stage}/${orchestratorId}-s3/access-key/${tenantId}`;
  let value: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    );
    value = Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      throw new Error(`${orchestratorId} S3 credentials not found in SSM for tenant ${tenantId}`, {
        cause: err,
      });
    }
    throw err;
  }

  if (!value) {
    throw new Error(`${orchestratorId} S3 credentials not found in SSM for tenant ${tenantId}`);
  }

  ssmCache.set(cacheKey, value);
  return JSON.parse(value) as S3Credentials;
}
