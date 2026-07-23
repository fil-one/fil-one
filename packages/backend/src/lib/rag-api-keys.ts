import { createHash, randomBytes } from 'node:crypto';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import type { RagKeyBucketRef, RagKeyBucketScope } from '@filone/shared';
import { RAG_KEY_DISPLAY_PREFIX_LENGTH, RAG_KEY_TOKEN_PREFIX } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';

/**
 * Storage and lookup for RAG API keys (bearer tokens for the query endpoint).
 *
 * Two UserInfoTable items per key, written/deleted atomically by the handlers:
 * - `pk: ORG#{orgId}, sk: RAGKEY#{keyId}` — the org-scoped record (listing,
 *   scope, ownership). Holds the token's SHA-256 hash, never the token.
 * - `pk: RAGKEYHASH#{sha256hex}, sk: LOOKUP` — maps a presented token's hash
 *   to (orgId, keyId). The table has no GSIs, so bearer auth needs this
 *   direct-addressable row.
 */

export const RagApiKeyKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  orgSk: (keyId: string): string => `RAGKEY#${keyId}`,
  orgSkPrefix: (): string => 'RAGKEY#',
  lookupPk: (tokenHash: string): string => `RAGKEYHASH#${tokenHash}`,
  lookupSk: (): string => 'LOOKUP',
} as const;

/** UserInfoTable — pk: ORG#{orgId}, sk: RAGKEY#{keyId} (unmarshalled shape). */
export interface RagKeyRecord {
  keyId: string;
  orgId: string;
  keyName: string;
  keyPrefix: string;
  tokenHash: string;
  bucketScope: RagKeyBucketScope;
  buckets?: RagKeyBucketRef[];
  createdBy: string;
  creatorEmail?: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** New bearer token: `sk_rag_` + 32 random bytes (256-bit entropy) base64url. */
export function generateRagKeyToken(): string {
  return `${RAG_KEY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Hash a token for storage/lookup. Unsalted SHA-256 is sufficient here: the
 * input is a 256-bit random value (not a guessable password), so brute-forcing
 * the hash is infeasible and equal tokens must map to equal keys for lookup.
 */
export function hashRagKeyToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Display-only prefix stored alongside the hash so list UIs can identify keys. */
export function ragKeyDisplayPrefix(token: string): string {
  return token.slice(0, RAG_KEY_DISPLAY_PREFIX_LENGTH);
}

/**
 * Resolve a presented bearer token to its key record, or null when the token
 * is unknown/revoked. Two GetItems: hash → LOOKUP row → org record. The LOOKUP
 * read is strongly consistent so a just-deleted key stops authenticating
 * immediately (delete removes the LOOKUP row in the same transaction).
 *
 * Never log the token (or its hash, which IS the credential lookup key) —
 * orphan diagnostics log the keyId only.
 */
export async function findRagKeyByToken(token: string): Promise<RagKeyRecord | null> {
  const dynamo = getDynamoClient();
  const tableName = Resource.UserInfoTable.name;
  const tokenHash = hashRagKeyToken(token);

  const lookup = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: RagApiKeyKeys.lookupPk(tokenHash) }, sk: { S: RagApiKeyKeys.lookupSk() } },
      ConsistentRead: true,
    }),
  );
  const orgId = lookup.Item?.orgId?.S;
  const keyId = lookup.Item?.keyId?.S;
  if (!orgId || !keyId) return null;

  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: RagApiKeyKeys.orgPk(orgId) }, sk: { S: RagApiKeyKeys.orgSk(keyId) } },
    }),
  );
  if (!result.Item) {
    // Should be unreachable: create/delete write both rows transactionally.
    console.error('[rag-key-auth] Orphaned RAGKEYHASH lookup row — org key record missing', {
      keyId,
    });
    return null;
  }

  const record = unmarshall(result.Item);
  return {
    keyId,
    orgId,
    keyName: record.keyName as string,
    keyPrefix: record.keyPrefix as string,
    tokenHash: record.tokenHash as string,
    bucketScope: record.bucketScope as RagKeyBucketScope,
    buckets: record.buckets as RagKeyBucketRef[] | undefined,
    createdBy: record.createdBy as string,
    creatorEmail: record.creatorEmail as string | undefined,
    createdAt: record.createdAt as string,
    lastUsedAt: record.lastUsedAt as string | undefined,
  };
}

/**
 * Whether a key's scope covers the requested (region, bucket). Scope entries
 * are (region, name) pairs because bucket names are region-scoped; 'all' means
 * every bucket of the key's org (org containment is enforced downstream by the
 * tenant-scoped bucket lookup, not here).
 */
export function ragKeyAllowsBucket(
  record: Pick<RagKeyRecord, 'bucketScope' | 'buckets'>,
  region: string,
  bucketName: string,
): boolean {
  if (record.bucketScope === 'all') return true;
  return (record.buckets ?? []).some((b) => b.region === region && b.name === bucketName);
}

/**
 * Best-effort `lastUsedAt` stamp on successful bearer auth. Awaited (a floating
 * promise could be dropped when the Lambda freezes after responding) but never
 * allowed to fail the request.
 */
export async function touchRagKeyLastUsed(orgId: string, keyId: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: RagApiKeyKeys.orgPk(orgId) }, sk: { S: RagApiKeyKeys.orgSk(keyId) } },
        UpdateExpression: 'SET lastUsedAt = :now',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':now': { S: new Date().toISOString() } },
      }),
    );
  } catch (err) {
    console.warn('[rag-key-auth] Failed to update lastUsedAt (continuing)', { keyId, error: err });
  }
}
