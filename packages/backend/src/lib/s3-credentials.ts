// Shared SSM-cached lookup of per-tenant S3 access keys for the
// ServiceOrchestrator implementations (FTH, Aurora, ...). Each orchestrator
// stashes its tenant's S3 credentials at
//   /filone/<stage>/<orchestratorId>-s3/access-key/<tenantId>
// during tenant setup; this helper centralises the cache + decryption +
// error translation so adding a third orchestrator does not require
// re-implementing the lookup.

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import pRetry from 'p-retry';
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
// Holds tenant console keys and per-member credentials together. Tenant entries
// never expire; member entries carry their own maxAge (see below). Sized for the
// member cardinality, which is per (tenant, user) rather than per tenant; each
// entry is a short JSON string.
const ssmCache = new QuickLRU<string, string>({ maxSize: 2000 });

// Mints already in flight in this container, so two concurrent requests from one
// member share a single key rather than racing to create two.
const inFlightMints = new Map<string, Promise<S3Credentials>>();

export const _resetS3CredentialsCacheForTesting = () => {
  ssmCache.clear();
  inFlightMints.clear();
};

export async function getConsoleS3Credentials(
  args: GetConsoleS3CredentialsArgs,
  requestOptions?: { signal?: AbortSignal },
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
      { abortSignal: requestOptions?.signal },
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

  // Ensure the value is valid JSON before caching it
  const credentials = JSON.parse(value) as S3Credentials;
  ssmCache.set(cacheKey, value);
  return credentials;
}

// ---------------------------------------------------------------------------
// Per-member credentials (iam regions)
// ---------------------------------------------------------------------------

/**
 * How long a member's credential may stay warm.
 *
 * The storage system can retire a key without telling the console: an operator
 * removing a principal, an expiry the console did not set. Past this age the
 * next signing request re-reads SSM and, finding nothing, mints again. It also
 * covers a presigned URL, whose 403 lands in the browser and never reaches the
 * Lambda, so no retry can see it.
 */
export const MEMBER_CREDENTIAL_MAX_AGE_MS = 5 * 60_000;

// Retries the parameter write, not the mint. Standard-tier PutParameter runs at
// 3 TPS per account per AWS region, and a region flipping to the `iam` model
// mints one key per member as each first signs, so bursts are expected.
const MEMBER_KEY_WRITE_RETRY = {
  retries: 4,
  minTimeout: 200,
  maxTimeout: 2000,
  randomize: true,
} as const;

/**
 * The name of a member's console key at the storage system.
 *
 * The user id is in the name rather than only in the principal binding, which
 * makes the name unique across the tenant and lets `findAccessKeyByName` recover
 * a key whose secret was lost. Key names are unique per principal, so this
 * cannot collide with a key the member created for themselves.
 */
export const memberConsoleKeyName = (userId: string) => `filone-console/${userId}`;

/**
 * Where a member's credential lives.
 *
 * A sibling of the tenant's `access-key/{tenantId}`, so the existing
 * `/filone/{stage}/{orchestratorId}-s3/*` grants already cover it and an
 * operator can tell the two apart by prefix. `userId` is a randomUUID, so it is
 * already legal in a parameter name; an Auth0 `sub` (`auth0|…`) would not be.
 *
 * ponytail: standard-tier SSM caps an account at 10,000 parameters per AWS
 * region, shared across every stage in the account and with the tenant console
 * keys above. This is one parameter per member per orchestrator. At roughly half
 * the ceiling, move member credentials to DynamoDB and encrypt the secret with
 * KMS Encrypt/Decrypt directly — no data-key envelope, the secret is far under
 * the 4 KB inline limit — under an encryption context of { orgId, userId } so a
 * row cannot be decrypted for the wrong member. Advanced tier (100,000) is the
 * stopgap and bills per parameter per month.
 */
function memberKeyParameterName(args: MemberCredentialRef): string {
  return `/filone/${args.stage}/${args.orchestratorId}-s3/member-key/${args.tenantId}/${args.userId}`;
}

const memberCacheKey = (args: MemberCredentialRef) =>
  `${args.stage}/${args.orchestratorId}/${args.tenantId}/${args.userId}`;

/** Identifies one member's credential on one orchestrator. */
export interface MemberCredentialRef {
  orchestratorId: string;
  stage: string;
  tenantId: string;
  /** The console user the credential belongs to, which is also its principal id. */
  userId: string;
}

export interface GetMemberS3CredentialsArgs extends MemberCredentialRef {
  /**
   * Mints the member's key when SSM holds none. Called at most once per member
   * per container, behind the in-flight guard, and never with the caller's
   * abort signal: a request that gives up mid-mint must not leave a key whose
   * secret nobody holds.
   */
  mint: () => Promise<S3Credentials>;
}

/**
 * The member's principal-bound credential, minted on first use.
 *
 * What it may do is whatever the bucket policies give the member at the time of
 * each request, so the credential itself never changes when their access does.
 */
export async function getMemberS3Credentials(
  args: GetMemberS3CredentialsArgs,
  requestOptions?: { signal?: AbortSignal },
): Promise<S3Credentials> {
  const cacheKey = memberCacheKey(args);
  const cached = ssmCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as S3Credentials;

  const pending = inFlightMints.get(cacheKey);
  if (pending) return pending;

  const attempt = readOrMintMemberKey(args, requestOptions).finally(() => {
    inFlightMints.delete(cacheKey);
  });
  inFlightMints.set(cacheKey, attempt);
  return attempt;
}

async function readOrMintMemberKey(
  args: GetMemberS3CredentialsArgs,
  requestOptions?: { signal?: AbortSignal },
): Promise<S3Credentials> {
  const parameterName = memberKeyParameterName(args);

  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
      { abortSignal: requestOptions?.signal },
    );
    if (Parameter?.Value) {
      const credentials = JSON.parse(Parameter.Value) as S3Credentials;
      ssmCache.set(memberCacheKey(args), Parameter.Value, {
        maxAge: MEMBER_CREDENTIAL_MAX_AGE_MS,
      });
      return credentials;
    }
  } catch (err) {
    if ((err as { name?: string }).name !== 'ParameterNotFound') throw err;
  }

  const minted = await args.mint();
  const value = JSON.stringify(minted);
  // The key exists at the storage system from here on. If the write fails for
  // good, the next request mints again, collides on the deterministic key name
  // and recovers the orphan — see mintMemberConsoleKey.
  await pRetry(
    () =>
      ssm.send(
        new PutParameterCommand({
          Name: parameterName,
          Value: value,
          Type: 'SecureString',
          Overwrite: true,
        }),
        { abortSignal: requestOptions?.signal },
      ),
    {
      ...MEMBER_KEY_WRITE_RETRY,
      shouldRetry: ({ error }) => {
        const name = (error as { name?: string }).name;
        return name === 'ThrottlingException' || name === 'TooManyUpdates';
      },
    },
  );
  ssmCache.set(memberCacheKey(args), value, { maxAge: MEMBER_CREDENTIAL_MAX_AGE_MS });
  return minted;
}

/** Drops the member's cached credential so the next read goes back to SSM. */
export function evictMemberS3Credentials(args: MemberCredentialRef): void {
  ssmCache.delete(memberCacheKey(args));
}

/**
 * Removes a member's credential when their principal goes.
 *
 * Best-effort at the call site: a parameter left behind costs a signing failure
 * for someone no longer in the org, and the next mint's name collision repairs
 * it.
 */
export async function deleteMemberS3Credentials(
  args: MemberCredentialRef,
  requestOptions?: { signal?: AbortSignal },
): Promise<void> {
  ssmCache.delete(memberCacheKey(args));
  try {
    await ssm.send(new DeleteParameterCommand({ Name: memberKeyParameterName(args) }), {
      abortSignal: requestOptions?.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name !== 'ParameterNotFound') throw err;
  }
}
