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
import { isIdentityTombstoned } from './identity-tombstone.js';

/**
 * FIL-112 deletion race: the middleware's tombstone gate ran earlier on an
 * eventually-consistent read, so re-read consistently before any entitlement
 * side effect. Without it a login racing deletion could (a) claim the
 * EMAIL_NORM# key (retained by design, FIL-422) with no trial granted, locking
 * the email out of future trials, or (b) mint a Stripe trial after teardown's
 * billing snapshot, which teardown would never cancel.
 *
 * The residual window is now just tombstone read → PutItem of the trial row:
 * createBillingTrial writes that row before it touches Stripe, then re-verifies
 * against the tombstone and compensates (deletes the row) if the identity died
 * in between. The only residue is a crash between that Put and the Stripe
 * calls, which leaves a local-only 30-day trial row with no Stripe customer or
 * subscription behind it. That row is never resumed — it simply self-expires
 * through the existing trial → grace → canceled lifecycle, which runs entirely
 * off the stored trialEndsAt and needs no Stripe involvement.
 */

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

  if (await isIdentityTombstoned({ sub })) {
    console.warn('[trial-entitlement] Identity deleted or missing — skipping trial claim', {
      userId,
      orgId,
    });
    return false;
  }

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
      await createBillingTrial({ userId, orgId, email, userInfo: { sub } });
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
    // warn, not info: production Lambdas log at WARN (sst.config.ts
    // applicationLogLevel), and this permanent denial is the one line that
    // explains a "why am I locked out" ticket.
    console.warn('[trial-entitlement] Normalized email already claimed — no trial granted', {
      userId,
      orgId,
    });
  }

  // Optimization only: skip the re-check on future requests. Conditioned on a
  // live identity row so a request racing deletion (FIL-112) can't upsert a
  // ghost SUB# row or decorate the tombstone.
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
