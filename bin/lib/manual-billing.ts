// The billing-row write that moves an org onto manual billing, or back off it,
// decided from the row the script read. The runner is ../set-manual-billing.ts.

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { PAID_GRACE_DAYS, SubscriptionStatus } from '@filone/shared';
import type { SubscriptionRecord } from '@filone/backend/src/lib/dynamo-records.ts';

export type ManualBillingMode = 'set' | 'revert';

export interface ManualBillingPlan {
  update: {
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, AttributeValue>;
  };
  /** What the operator has to do by hand after the write. */
  warnings: string[];
}

/** The plan, or why there is none. */
export type Result<T> = { ok: true; value: T } | { ok: false; refusal: string };

const DAY_MS = 24 * 60 * 60 * 1000;

// Statuses that may have write-locked or disabled the org's tenants.
const LOCKING_STATUSES: ReadonlySet<string> = new Set([
  SubscriptionStatus.GracePeriod,
  SubscriptionStatus.Canceled,
]);

/**
 * The write for `mode`, conditioned on the status the script read, so a Stripe
 * event or a live request that changed the row in between refuses it.
 *
 * Reverting starts the paid grace period a lapsed subscription gets: the
 * enforcer then write-locks the tenants and disables them when it ends, and the
 * customer can pay by card to keep the account in the meantime.
 */
export function planManualBilling({
  mode,
  row,
  now,
}: {
  mode: ManualBillingMode;
  row: Pick<SubscriptionRecord, 'subscriptionStatus'> | undefined;
  now: Date;
}): Result<ManualBillingPlan> {
  if (!row) return { ok: false, refusal: 'The org has no billing row.' };
  const from = row.subscriptionStatus;
  const expected = expectedStatus(from);

  if (mode === 'revert') {
    if (from !== SubscriptionStatus.Manual) {
      return {
        ok: false,
        refusal: `The org is not billed manually (it is ${from ?? 'without a status'}).`,
      };
    }
    return {
      ok: true,
      value: {
        update: {
          UpdateExpression:
            'SET subscriptionStatus = :to, canceledAt = :now, gracePeriodEndsAt = :grace, updatedAt = :now',
          ConditionExpression: expected.condition,
          ExpressionAttributeValues: {
            ':to': { S: SubscriptionStatus.GracePeriod },
            ...expected.values,
            ':now': { S: now.toISOString() },
            ':grace': { S: new Date(now.getTime() + PAID_GRACE_DAYS * DAY_MS).toISOString() },
          },
        },
        warnings: [],
      },
    };
  }

  if (from === SubscriptionStatus.Manual) {
    return { ok: false, refusal: 'The org is already billed manually.' };
  }
  return {
    ok: true,
    value: {
      update: {
        UpdateExpression:
          'SET subscriptionStatus = :to, updatedAt = :now ' +
          'REMOVE gracePeriodEndsAt, canceledAt, lastPaymentFailedAt',
        ConditionExpression: expected.condition,
        ExpressionAttributeValues: {
          ':to': { S: SubscriptionStatus.Manual },
          ...expected.values,
          ':now': { S: now.toISOString() },
        },
      },
      warnings:
        from && LOCKING_STATUSES.has(from)
          ? [
              `The org was ${from}, so its tenants may be write-locked or disabled. ` +
                'This script does not unlock them.',
            ]
          : [],
    },
  };
}

function expectedStatus(from: string | undefined): {
  condition: string;
  values: Record<string, AttributeValue>;
} {
  // attribute_exists(pk) keeps the write from creating a row deleted since the read.
  return from
    ? {
        condition: 'attribute_exists(pk) AND subscriptionStatus = :from',
        values: { ':from': { S: from } },
      }
    : {
        condition: 'attribute_exists(pk) AND attribute_not_exists(subscriptionStatus)',
        values: {},
      };
}
