import {
  ConditionalCheckFailedException,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { createBillingTrial } from './create-billing-trial.js';
import { normalizeEmailForEntitlement } from './email-normalization.js';
import { TrialEntitlementError } from './errors.js';

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
 */
export async function ensureTrialEntitlement({
  sub,
  userId,
  orgId,
  email,
  emailVerified,
}: EnsureTrialEntitlementParams): Promise<boolean> {
  if (!emailVerified || !email) return false;

  const tableName = Resource.UserInfoTable.name;
  const normalizedEmail = normalizeEmailForEntitlement(email);
  const now = new Date().toISOString();

  // ALL_OLD lets us read the existing owner on conflict.
  let ownerUserId: string | undefined;
  try {
    await getDynamoClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: `EMAIL_NORM#${normalizedEmail}` },
          sk: { S: 'TRIAL_ENTITLEMENT' },
          userId: { S: userId },
          createdAt: { S: now },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
    ownerUserId = userId;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      ownerUserId = err.Item?.userId?.S;
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
  if (ownerUserId === userId) {
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
  } else {
    console.info('[trial-entitlement] Normalized email already claimed — no trial granted', {
      userId,
      orgId,
    });
  }

  // Optimization only: skip the re-check on future requests. Conditioned on a
  // live identity row (FIL-112): an in-flight request racing account deletion
  // must not upsert a ghost SUB# row or decorate the deletion tombstone.
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
        UpdateExpression: 'SET emailEntitlementClaimed = :t',
        ConditionExpression: 'attribute_exists(pk) AND attribute_exists(userId)',
        ExpressionAttributeValues: { ':t': { BOOL: true } },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      console.info('[trial-entitlement] Identity row gone or tombstoned; flag not set', {
        userId,
      });
    } else {
      console.error('[trial-entitlement] Failed to set emailEntitlementClaimed flag', {
        error,
        userId,
      });
    }
  }

  return entitled;
}
