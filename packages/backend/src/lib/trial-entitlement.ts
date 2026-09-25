import {
  type AttributeValue,
  ConditionalCheckFailedException,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';
import { createBillingTrial } from './create-billing-trial.ts';
import { normalizeEmailForEntitlement } from './email-normalization.ts';
import { TrialEntitlementError } from './errors.ts';

/** UserInfoTable keys of the one-trial-per-person claim. */
export const TrialEntitlementKeys = {
  pk: (normalizedEmail: string): string => `EMAIL_NORM#${normalizedEmail}`,
  pkPrefix: (): string => 'EMAIL_NORM#',
  sk: (): string => 'TRIAL_ENTITLEMENT',
} as const;

export interface EnsureTrialEntitlementParams {
  sub: string;
  userId: string;
  orgId: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Claim the normalized-email entitlement key (verified emails only) and grant a
 * trial to the account that wins the claim. Returns true iff a trial was ensured.
 *
 * One trial per person, ever: the claim records the org it was spent on, and
 * only that org can come back for it (a retry after a failed
 * `createBillingTrial`). The same person asking from any other org, one they
 * created or the floor org leaving their last one makes, is refused. A claim
 * written before the org was recorded has no `orgId`: its owner's first request
 * stamps the org it comes from, so an interrupted claim can still be retried.
 */
export async function ensureTrialEntitlement({
  sub,
  userId,
  orgId,
  email,
  emailVerified,
}: EnsureTrialEntitlementParams): Promise<boolean> {
  if (!emailVerified || !email) {
    console.warn('[trial-entitlement] No verified email on the request — refusing the claim', {
      userId,
      orgId,
      hasEmail: Boolean(email),
      emailVerified,
    });
    return false;
  }

  const tableName = Resource.UserInfoTable.name;
  const normalizedEmail = normalizeEmailForEntitlement(email);
  const now = new Date().toISOString();

  // ALL_OLD lets us read the existing owner, and the org it was spent on, on
  // conflict.
  let ownerUserId: string | undefined;
  let claimedOrgId: string | undefined;
  try {
    await getDynamoClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: TrialEntitlementKeys.pk(normalizedEmail) },
          sk: { S: TrialEntitlementKeys.sk() },
          userId: { S: userId },
          orgId: { S: orgId },
          createdAt: { S: now },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
    ownerUserId = userId;
    claimedOrgId = orgId;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      ownerUserId = err.Item?.userId?.S;
      claimedOrgId = await claimedOrgOf(err.Item, { normalizedEmail, userId, orgId });
    } else {
      console.error('[trial-entitlement] Failed to claim entitlement key', {
        error: err,
        userId,
        orgId,
      });
      // Transient infra failure (not a "not entitled" outcome). Throw so the
      // caller surfaces a retryable 5xx; the flag stays unset so a later request
      // still retries the claim.
      throw new TrialEntitlementError('Failed to claim trial entitlement key', {
        cause: err,
      });
    }
  }

  let entitled = false;
  if (ownerUserId === userId && claimedOrgId === orgId) {
    try {
      await createBillingTrial({ userId, orgId, email });
      entitled = true;
    } catch (error) {
      console.error('[trial-entitlement] Failed to create billing trial', {
        error,
        userId,
        orgId,
      });
      // Transient billing failure (e.g. Stripe down). Throw for a retryable 5xx;
      // createBillingTrial is idempotent on retry and the flag stays unset.
      throw new TrialEntitlementError('Failed to create billing trial', {
        cause: error,
      });
    }
  } else if (ownerUserId === userId) {
    console.warn('[trial-entitlement] Trial already spent on another org; no trial granted', {
      userId,
      orgId,
      claimedOrgId,
    });
  } else {
    // warn, not info: production Lambdas log at WARN (sst.config.ts
    // applicationLogLevel), and this permanent denial is the one line that
    // explains a "why am I locked out" ticket.
    console.warn('[trial-entitlement] Normalized email already claimed — no trial granted', {
      userId,
      orgId,
    });
  }

  // Optimization only: skip the re-check on future requests.
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
        UpdateExpression: 'SET emailEntitlementClaimed = :t',
        ExpressionAttributeValues: { ':t': { BOOL: true } },
      }),
    );
  } catch (error) {
    console.error('[trial-entitlement] Failed to set emailEntitlementClaimed flag', {
      error,
      userId,
    });
  }

  return entitled;
}

/**
 * The org an existing claim is spent on. The caller's own claim with no org
 * recorded is stamped with this one first, unless a racing request stamped it.
 */
async function claimedOrgOf(
  claim: Record<string, AttributeValue> | undefined,
  { normalizedEmail, userId, orgId }: { normalizedEmail: string; userId: string; orgId: string },
): Promise<string | undefined> {
  const claimedOrgId = claim?.orgId?.S;
  if (claimedOrgId !== undefined || claim?.userId?.S !== userId) return claimedOrgId;
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: {
          pk: { S: TrialEntitlementKeys.pk(normalizedEmail) },
          sk: { S: TrialEntitlementKeys.sk() },
        },
        UpdateExpression: 'SET orgId = :orgId',
        ConditionExpression: 'attribute_not_exists(orgId) AND userId = :userId',
        ExpressionAttributeValues: { ':orgId': { S: orgId }, ':userId': { S: userId } },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
    return orgId;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return err.Item?.orgId?.S;
    throw new TrialEntitlementError('Failed to record the org on a trial entitlement', {
      cause: err,
    });
  }
}
