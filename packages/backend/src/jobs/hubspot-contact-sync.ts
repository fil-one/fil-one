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
      const record = unmarshall(item);
      if (typeof record.pk !== 'string') continue;
      yield {
        userId: record.pk.replace('CUSTOMER#', ''),
        orgId: record.orgId,
        stripeCustomerId: record.stripeCustomerId,
        subscriptionStatus: record.subscriptionStatus,
      };
    }

    cursor = result.LastEvaluatedKey;
  } while (cursor);
}
