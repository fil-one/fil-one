import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { DeletionKeys, type OrgTombstoneRecord } from './dynamo-records.js';

const dynamo = getDynamoClient();

/**
 * The Stripe CUSTOMER object is kept (finance/audit needs the reference) while
 * its PII is erased via a Redaction Job, so this PII-free tombstone preserves
 * the customer id across the account purge.
 *
 * A tombstone already naming a DIFFERENT customer is never silently
 * overwritten: that would strand the previously-recorded customer with no
 * pointer left to redact it by. On a first teardown that disagreement is an
 * invariant violation, so it throws and keeps the DELETION record non-DONE for
 * the re-drive / manual follow-up. On a RESWEEP it is the expected signature of
 * a resurrection — the completed teardown tombstoned the original customer and
 * a post-purge writer minted a new one — so the tombstone is left naming the
 * original (nothing is stranded) and the caller records and redacts the new
 * one. A pass that discovers nothing leaves an existing id in place rather than
 * erasing it.
 *
 * The read below is only a snapshot — {@link tombstoneCondition} is what
 * actually holds that invariant against two overlapping workers (whose
 * discovery calls can straddle the Stripe index lag and so disagree). Losing
 * that race is only an error when the two passes genuinely disagree: a pass
 * that discovered nothing accepts the winner's tombstone (see the catch).
 *
 * @returns the customer id the tombstone names after this call, if any.
 */
export async function writeOrgTombstone(
  orgId: string,
  customerId: string | undefined,
  resweep: boolean,
): Promise<string | undefined> {
  const key = { pk: DeletionKeys.tombstonePk(orgId), sk: DeletionKeys.tombstoneSk() };
  const current = await readTombstone(key);
  const disagreement = disagreesWith(current, customerId);
  if (disagreement) {
    if (!resweep) throw mismatchError(orgId, disagreement, customerId!);
    return disagreement;
  }

  const recordedCustomerId = customerId ?? current?.stripeCustomerId;
  // Already exactly right — skip the write rather than re-stamping `deletedAt`
  // on every pass. That field is the audit answer to "when was this org
  // deleted?", so it must keep naming the first pass, not the last.
  if (current && current.stripeCustomerId === recordedCustomerId) return recordedCustomerId;

  const tombstone: OrgTombstoneRecord = {
    ...key,
    orgId,
    ...(recordedCustomerId ? { stripeCustomerId: recordedCustomerId } : {}),
    deletedAt: current?.deletedAt ?? new Date().toISOString(),
  };
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.BillingTable.name,
        Item: marshall(tombstone),
        ...tombstoneCondition(recordedCustomerId),
      }),
    );
    return recordedCustomerId;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    return resolveTombstoneConflict(orgId, key, recordedCustomerId);
  }
}

/**
 * Settle a lost tombstone-write race. A pass that discovered NOTHING had
 * nothing to write, so an overlapping worker that landed a customer id first
 * has strictly the better tombstone: accept it instead of failing this whole
 * pass over a benign upgrade. Only a genuine disagreement (or a still-id-less
 * tombstone, which means the condition failed for a reason we do not
 * understand) is fatal.
 */
async function resolveTombstoneConflict(
  orgId: string,
  key: { pk: string; sk: string },
  recordedCustomerId: string | undefined,
): Promise<string> {
  const winner = recordedCustomerId === undefined ? await readTombstone(key) : undefined;
  if (winner?.stripeCustomerId) return winner.stripeCustomerId;
  throw new Error(
    `Org ${orgId} tombstone was written concurrently while this pass was recording Stripe ` +
      `customer ${recordedCustomerId ?? '(none discovered)'}; refusing to overwrite — ` +
      'the next teardown pass re-reads it',
  );
}

/** The recorded customer id when it contradicts what discovery just found, else undefined. */
function disagreesWith(
  current: OrgTombstoneRecord | undefined,
  customerId: string | undefined,
): string | undefined {
  const recorded = current?.stripeCustomerId;
  if (!recorded || !customerId || recorded === customerId) return undefined;
  return recorded;
}

function mismatchError(orgId: string, recorded: string, discovered: string): Error {
  return new Error(
    `Org ${orgId} tombstone already records Stripe customer ${recorded} but discovery found ` +
      `${discovered}; refusing to overwrite — manual follow-up required`,
  );
}

/** Strongly-consistent read of the org's tombstone; absent reads as undefined. */
async function readTombstone(key: {
  pk: string;
  sk: string;
}): Promise<OrgTombstoneRecord | undefined> {
  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: marshall(key),
      ConsistentRead: true,
    }),
  );
  return existing.Item ? (unmarshall(existing.Item) as OrgTombstoneRecord) : undefined;
}

/**
 * The tombstone's write condition. A tombstone that names a customer may never
 * be replaced — neither by one naming a different customer nor by one naming
 * none at all, which is the case the check-then-write above cannot see and
 * which would destroy the last pointer to redact by. Upgrading a tombstone that
 * names NO customer to one that does is allowed: that is the post-purge pass
 * recording a late (race-window) find, and it strands nothing.
 */
function tombstoneCondition(recordedCustomerId: string | undefined) {
  const noNamedCustomer = 'attribute_not_exists(pk) OR attribute_not_exists(stripeCustomerId)';
  if (!recordedCustomerId) return { ConditionExpression: noNamedCustomer };
  return {
    ConditionExpression: `${noNamedCustomer} OR stripeCustomerId = :id`,
    ExpressionAttributeValues: marshall({ ':id': recordedCustomerId }),
  };
}
