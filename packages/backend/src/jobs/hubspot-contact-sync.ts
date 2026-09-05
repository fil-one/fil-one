import { BatchGetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import {
  type ContactWriteOutcome,
  upsertContactSubscriptionStatus,
} from '../lib/hubspot-client.js';
import { fromInternalStatus } from '../lib/hubspot-lifecycle-status.js';
import { type ContactSyncSummary, emitContactSyncSummary } from '../lib/hubspot-metrics.js';
import {
  type ScannedSubscription,
  scanSubscriptions,
  updateSubscriptionByUser,
} from '../lib/subscription-store.js';

const JOB = 'hubspot-contact-sync';
const LOG = `[${JOB}]`;

/**
 * Contacts reconciled per run. The job reconciles a slice rather than the whole
 * population: three network calls per row over every billing record is what used
 * to exhaust the Lambda's timeout. `truncated` says whether a slice was enough.
 */
const MAX_CONTACTS_PER_RUN = 100;

/** DynamoDB's own ceiling on `BatchGetItem` keys, unrelated to the run cap. */
const BATCH_GET_LIMIT = 100;

/** Re-reads of the leftovers a throttled `BatchGetItem` declines to serve. */
const UNPROCESSED_RETRIES = 2;

const REVERIFY_AFTER_DAYS = 30;

const USER_PREFIX = 'USER#';
const PROFILE_SK = 'PROFILE';

const dynamo = getDynamoClient();

/**
 * A row qualifies when the job has never attempted it, when its last attempt is
 * old enough to re-verify, or when its status has moved since HubSpot last
 * confirmed one.
 *
 * The gate is `hubspotSyncedAt`, the attempt marker, NOT
 * `hubspotSubscriptionStatus`, the success marker. Selecting on a missing
 * success marker starves the job: a contact HubSpot cannot match — no id on any
 * contact and no address to bootstrap one — never gets a status written, so it
 * stays eligible for every future run, and a hundred of those fill the per-run
 * cap forever while the rest of the backlog goes untouched.
 *
 * The staleness clause is also what keeps the counters meaningful. Since the job
 * stopped reading HubSpot back, "in sync" means "our stamp matches our status",
 * so a contact whose property was edited or cleared inside HubSpot would
 * otherwise never be looked at again, and `unmatched` would stop answering "how
 * many customers is this silently missing" once the backlog drained.
 */
const PENDING_FILTER = `sk = :sk
  AND attribute_exists(subscriptionStatus)
  AND attribute_not_exists(deletedAt)
  AND (
    attribute_not_exists(hubspotSyncedAt)
    OR hubspotSyncedAt < :staleBefore
    OR hubspotSubscriptionStatus <> subscriptionStatus
  )`;

/**
 * A row this run may reconcile.
 *
 * `userId` is required where `ScannedSubscription` leaves it optional: it is the
 * property HubSpot addresses its contacts by, so a row naming no user names no
 * contact.
 */
interface Candidate extends ScannedSubscription {
  userId: string;
  subscriptionStatus: SubscriptionStatus;
  hubspotSubscriptionStatus?: SubscriptionStatus;
  stripeCustomerId?: string;
  email?: string;
}

/**
 * Reconciles a slice of the billing records' subscription status into HubSpot.
 *
 * Serves three purposes at once: it backfills contacts that predate this sync,
 * it repairs best-effort webhook writes that were dropped, and its counters
 * answer "how many customers is this silently missing".
 *
 * Each run takes at most `MAX_CONTACTS_PER_RUN` rows and stamps every one it
 * reconciles, so successive runs walk the backlog down rather than re-doing it.
 * `truncated` is what says a backlog is still there.
 */
export async function syncAllContacts(): Promise<ContactSyncSummary> {
  const summary: ContactSyncSummary = {
    total: 0,
    matched: 0,
    unmatched: 0,
    writeFailed: 0,
    repaired: 0,
    truncated: 0,
    missingEmail: 0,
    missingUserId: 0,
  };

  // One more than the run takes, so a full return distinguishes "exactly a
  // batch was pending" from "rows were left behind".
  const scanned = await scanSubscriptions<Candidate>({
    job: JOB,
    filterExpression: PENDING_FILTER,
    expressionAttributeValues: {
      ':sk': { S: 'SUBSCRIPTION' },
      ':staleBefore': { S: reverifyBefore() },
    },
    limit: MAX_CONTACTS_PER_RUN + 1,
    select: (record, owner) => toCandidate(record, owner, summary),
  });

  if (scanned.length > MAX_CONTACTS_PER_RUN) summary.truncated = 1;

  const candidates = await withProfileEmails(scanned.slice(0, MAX_CONTACTS_PER_RUN), summary);

  for (const candidate of candidates) {
    summary.total += 1;
    const outcome = await reconcile(candidate, summary);
    // A throw records nothing: a HubSpot outage should be retried on the next
    // run, not held off for the whole re-verify window.
    if (outcome) await recordAttempt(candidate, outcome);
  }

  return summary;
}

export async function handler(): Promise<void> {
  console.warn(`${LOG} start`);
  const summary = await syncAllContacts();
  emitContactSyncSummary(summary);
  console.warn(`${LOG} complete`, summary);
}

async function reconcile(
  candidate: Candidate,
  summary: ContactSyncSummary,
): Promise<ContactWriteOutcome | undefined> {
  const { userId, email, subscriptionStatus, hubspotSubscriptionStatus } = candidate;
  const fromStatus = fromInternalStatus(hubspotSubscriptionStatus);
  const toStatus = fromInternalStatus(subscriptionStatus);

  try {
    const outcome = await upsertContactSubscriptionStatus({ userId, status: toStatus, email });

    if (outcome === 'unmatched') {
      summary.unmatched += 1;
      console.warn(`${LOG} unmatched`, {
        userId,
        orgId: candidate.orgId,
        stripeCustomerId: candidate.stripeCustomerId,
        expected: toStatus,
      });
      return outcome;
    }

    summary.matched += 1;
    // Only a contact we had already stamped with a different value was drifting;
    // an unstamped row is a bootstrap, not a dropped write.
    if (hubspotSubscriptionStatus && hubspotSubscriptionStatus !== subscriptionStatus) {
      summary.repaired += 1;
      console.warn(`${LOG} repaired`, { userId, from: fromStatus, to: toStatus });
    }

    return outcome;
  } catch (error) {
    summary.writeFailed += 1;
    console.error(`${LOG} sync failed`, { userId, expected: toStatus, error });
  }
}

/**
 * Records that this row was attempted, and what HubSpot now holds if anything.
 *
 * Two attributes, because "we looked" and "HubSpot holds this" are different
 * facts and the filter needs them apart. `hubspotSyncedAt` always moves, which
 * is what stops an unmatchable contact monopolising every future run.
 * `hubspotSubscriptionStatus` is the value HubSpot confirmed holding, so an
 * `unmatched` outcome REMOVES it rather than leaving a claim standing: HubSpot
 * holds no contact for this user, and a stale value left behind would keep the
 * row eligible on the disagreeing-status clause and starve the job anyway.
 *
 * Goes through `updateSubscriptionByUser` for the key: the row is addressed
 * `ORG#{orgId}` and `UpdateItem` creates whatever key it is given, so writing
 * this to any other one both loses the progress mark and leaves a phantom
 * billing row behind.
 */
async function recordAttempt(candidate: Candidate, outcome: ContactWriteOutcome): Promise<void> {
  const confirmed = outcome !== 'unmatched';

  await updateSubscriptionByUser(
    { orgId: candidate.orgId, userId: candidate.userId },
    {
      UpdateExpression: confirmed
        ? 'SET hubspotSubscriptionStatus = :status, hubspotSyncedAt = :syncedAt'
        : 'SET hubspotSyncedAt = :syncedAt REMOVE hubspotSubscriptionStatus',
      ExpressionAttributeValues: {
        ...(confirmed ? { ':status': { S: candidate.subscriptionStatus } } : {}),
        ':syncedAt': { S: new Date().toISOString() },
      },
      // A row deleted between the scan and here is a no-op, not a failed run.
      tolerateMissingRow: true,
    },
  );
}

/** The row as a candidate, or nothing — with the reason counted, not just logged. */
function toCandidate(
  record: Record<string, unknown>,
  owner: ScannedSubscription,
  summary: ContactSyncSummary,
): Candidate | undefined {
  if (!owner.userId) {
    // `scanSubscriptions` has already warned with the pk. Counting it here is
    // what keeps a dropped row from reading as a smaller population.
    summary.missingUserId += 1;
    return undefined;
  }

  const subscriptionStatus = asStatus(record.subscriptionStatus);
  if (!subscriptionStatus) {
    console.error(`${LOG} unreadable subscription status`, { pk: owner.pk, orgId: owner.orgId });
    return undefined;
  }

  const hubspotSubscriptionStatus = asStatus(record.hubspotSubscriptionStatus);
  const stripeCustomerId =
    typeof record.stripeCustomerId === 'string' ? record.stripeCustomerId : undefined;

  return {
    ...owner,
    userId: owner.userId,
    subscriptionStatus,
    ...(hubspotSubscriptionStatus ? { hubspotSubscriptionStatus } : {}),
    ...(stripeCustomerId ? { stripeCustomerId } : {}),
  };
}

/**
 * `fromInternalStatus` is total over unrecognised values, so this only has to
 * reject a non-string — it does not have to know the enum's members.
 */
function asStatus(value: unknown): SubscriptionStatus | undefined {
  return typeof value === 'string' && value ? (value as SubscriptionStatus) : undefined;
}

function reverifyBefore(): string {
  return new Date(Date.now() - REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Each candidate with the address on its profile row, where there is one.
 *
 * The address bootstraps a contact HubSpot does not already carry our user id
 * for, and it is used at most once per contact — the id is written alongside the
 * status, so later writes address the contact directly (`hubspot-client`). A
 * candidate without one can still be reconciled; it just cannot be bootstrapped,
 * which is what `missingEmail` counts.
 */
async function withProfileEmails(
  candidates: Candidate[],
  summary: ContactSyncSummary,
): Promise<Candidate[]> {
  const emails = await readProfileEmails([...new Set(candidates.map((c) => c.userId))]);

  return candidates.map((candidate) => {
    const email = emails.get(candidate.userId);
    if (!email) summary.missingEmail += 1;
    return { ...candidate, ...(email ? { email } : {}) };
  });
}

async function readProfileEmails(userIds: string[]): Promise<Map<string, string>> {
  const tableName = Resource.UserInfoTable.name;
  const emails = new Map<string, string>();

  for (let start = 0; start < userIds.length; start += BATCH_GET_LIMIT) {
    let keys = userIds.slice(start, start + BATCH_GET_LIMIT).map(profileKey);

    // BatchGetItem reports the keys it declined rather than throwing, so a
    // throttled page costs those contacts their address unless the leftovers
    // are asked for again. Re-read immediately and give up after a couple of
    // tries: the next run reconciles them anyway, and the miss is counted.
    for (let attempt = 0; keys.length > 0 && attempt <= UNPROCESSED_RETRIES; attempt += 1) {
      const result = await dynamo.send(
        new BatchGetItemCommand({
          RequestItems: {
            [tableName]: {
              Keys: keys,
              ProjectionExpression: 'pk, email',
            },
          },
        }),
      );

      for (const item of result.Responses?.[tableName] ?? []) {
        const profile = toProfile(unmarshall(item));
        if (profile?.email) emails.set(profile.userId, profile.email);
      }

      keys = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
    }

    if (keys.length > 0) {
      console.error(`${LOG} profile reads left unprocessed`, { count: keys.length });
    }
  }

  return emails;
}

function profileKey(userId: string): Record<string, AttributeValue> {
  return { pk: { S: `${USER_PREFIX}${userId}` }, sk: { S: PROFILE_SK } };
}

function toProfile(
  record: Record<string, unknown>,
): { userId: string; email?: string } | undefined {
  if (typeof record.pk !== 'string' || !record.pk.startsWith(USER_PREFIX)) {
    console.error(`${LOG} unexpected row in place of a user profile`, { pk: record.pk });
    return undefined;
  }

  const userId = record.pk.slice(USER_PREFIX.length);
  if (!userId) {
    console.error(`${LOG} user profile row naming no user`, { pk: record.pk });
    return undefined;
  }

  return {
    userId,
    email: typeof record.email === 'string' && record.email ? record.email : undefined,
  };
}
