import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import {
  getContactSubscriptionStatus,
  upsertContactSubscriptionStatus,
} from '../lib/hubspot-client.js';
import { fromInternalStatus } from '../lib/hubspot-lifecycle-status.js';
import { type ContactSyncSummary, emitContactSyncSummary } from '../lib/hubspot-metrics.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { SubscriptionKeys } from '../lib/subscription-store.js';

const dynamo = getDynamoClient();

const LOG = '[hubspot-contact-sync]';

interface Candidate {
  userId: string;
  orgId?: string;
  stripeCustomerId?: string;
  subscriptionStatus: SubscriptionStatus;
}

/**
 * Reconciles every billing record's subscription status into HubSpot.
 *
 * Serves three purposes at once: its first run backfills every contact that
 * predates this sync, it repairs best-effort webhook writes that were dropped,
 * and its counters answer "how many customers is this silently missing".
 */
export async function syncAllContacts(): Promise<ContactSyncSummary> {
  const summary: ContactSyncSummary = {
    total: 0,
    matched: 0,
    unmatched: 0,
    writeFailed: 0,
    repaired: 0,
  };

  for await (const candidate of scanSubscriptions(Resource.BillingTable.name)) {
    summary.total += 1;
    await reconcile(candidate, summary);
  }

  return summary;
}

export async function handler(): Promise<void> {
  console.warn(`${LOG} start`);
  const summary = await syncAllContacts();
  emitContactSyncSummary(summary);
  console.warn(`${LOG} complete`, summary);
}

async function reconcile(candidate: Candidate, summary: ContactSyncSummary): Promise<void> {
  const { userId, subscriptionStatus } = candidate;
  const expected = fromInternalStatus(subscriptionStatus);

  try {
    const current = await getContactSubscriptionStatus(userId);
    if (current === expected) {
      summary.matched += 1;
      return;
    }

    // A null read means no contact carries our id yet, so the write needs an
    // email to bootstrap on. Stripe is the only place we hold one — it is not
    // persisted in either DynamoDB table.
    const email = current === null ? await resolveStripeEmail(candidate) : undefined;
    const outcome = await upsertContactSubscriptionStatus({ userId, status: expected, email });

    if (outcome === 'unmatched') {
      summary.unmatched += 1;
      console.warn(`${LOG} unmatched`, {
        userId,
        orgId: candidate.orgId,
        stripeCustomerId: candidate.stripeCustomerId,
        expected,
      });
      return;
    }

    summary.matched += 1;
    // Only a contact that held a different non-null value was actually drifting;
    // a null was never written before and is a bootstrap, not a dropped write.
    if (current !== null) {
      summary.repaired += 1;
      console.warn(`${LOG} repaired`, { userId, from: current, to: expected });
    }
  } catch (error) {
    summary.writeFailed += 1;
    console.error(`${LOG} sync failed`, { userId, expected, error });
  }
}

async function resolveStripeEmail(candidate: Candidate): Promise<string | undefined> {
  if (!candidate.stripeCustomerId) return undefined;
  try {
    const customer = await getStripeClient().customers.retrieve(candidate.stripeCustomerId);
    if ('deleted' in customer && customer.deleted) return undefined;
    return customer.email ?? undefined;
  } catch (error) {
    console.error(`${LOG} Stripe customer lookup failed`, {
      userId: candidate.userId,
      stripeCustomerId: candidate.stripeCustomerId,
      error,
    });
    return undefined;
  }
}

/**
 * The candidate a scanned row names, or nothing.
 *
 * The row is keyed `ORG#{orgId}` since the billing re-key, so the user id
 * HubSpot stamps on its contacts comes off the row's own `userId` attribute; a
 * pre-cleanup `CUSTOMER#` row still standing carries it in the key instead. A
 * row with neither names no contact to reconcile, and syncing under its `pk`
 * would write the org id into HubSpot as a user id.
 */
function toCandidate(record: Record<string, unknown>): Candidate | undefined {
  if (typeof record.pk !== 'string') return undefined;

  const userId =
    typeof record.userId === 'string' && record.userId
      ? record.userId
      : SubscriptionKeys.parseLegacyPk(record.pk);

  if (!userId) {
    console.error(`${LOG} no user id on subscription row`, { pk: record.pk, orgId: record.orgId });
    return undefined;
  }

  return {
    userId,
    orgId: record.orgId as string | undefined,
    stripeCustomerId: record.stripeCustomerId as string | undefined,
    subscriptionStatus: record.subscriptionStatus as SubscriptionStatus,
  };
}

// Scan filters are applied after consuming RCUs for the full table; the same
// deferred GSI on subscriptionStatus noted in subscription-drift-checker would
// help here too.
async function* scanSubscriptions(billingTableName: string): AsyncGenerator<Candidate> {
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: billingTableName,
        FilterExpression: 'sk = :sk AND attribute_exists(subscriptionStatus)',
        ExpressionAttributeValues: { ':sk': { S: 'SUBSCRIPTION' } },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const candidate = toCandidate(unmarshall(item));
      if (candidate) yield candidate;
    }

    cursor = result.LastEvaluatedKey;
  } while (cursor);
}
