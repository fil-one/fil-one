import {
  ConditionalCheckFailedException,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { OrgRole, isOrgRole } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { reportMetric } from '../lib/metrics.js';
import { OrgKeys } from '../lib/org-membership.js';

/**
 * Recounts every org's Owners and repairs a diverged `ownerCount`.
 *
 * The last-Owner invariant is a counter — `ownerCount` on the
 * `ORG#{orgId}` / `META` row — and every transaction that changes an org's
 * owner set carries its own delta, with the guard against removing the last
 * Owner expressed as that update's condition
 * (`docs/architectural-decisions/2026-08-organizations-roles-m1.md` §1). A
 * counter maintained that way is only ever as good as the writes that touched
 * it: a hand-edited row, a conversion that wrote a membership without its
 * delta, or a bug in a future owner-set transaction leaves the counter saying
 * one thing and the rows another, and the counter is what the guard reads. The
 * ADR's answer, and this job, is a periodic recount, because a counter with no
 * reconciliation path eventually lies.
 *
 * The `MEMBER#` rows are authoritative and the counter is derived, so the
 * recount never adjusts membership — it reports what is true and rewrites the
 * counter to match, including down to zero. An org with no Owner is a real
 * incident (nobody can invite, promote, or manage billing), and inventing an
 * Owner to make the counter defensible would hide it.
 */

const dynamo = getDynamoClient();

/**
 * The org partitions' key prefix, taken from the builder rather than spelled
 * again, so the day an org key gains a segment this scan still matches.
 */
const ORG_PK_PREFIX = OrgKeys.orgPk('');

/** What one org's rows add up to over the scan. */
interface OrgTally {
  /** `MEMBER#` rows of any role — what makes the partition a real org. */
  members: number;
  /** `MEMBER#` rows holding {@link OrgRole.Owner}: the authoritative count. */
  owners: number;
  /** Whether an `ORG#{orgId}` / `META` row was seen at all. */
  hasMeta: boolean;
  /** The counter as stored; undefined when the META row carried none. */
  storedOwnerCount?: number;
}

interface RunStats {
  /** Orgs the scan found rows for. */
  orgs: number;
  /** Orgs whose counter disagreed with the recount. */
  drifted: number;
  repaired: number;
  /** Repairs that lost their condition to a concurrent membership change. */
  skipped: number;
  repairFailed: number;
  /** Orgs the recount found no Owner in. */
  noOwner: number;
}

export async function handler(): Promise<void> {
  console.log('[owner-count-drift-checker] start');

  const tallies = await scanOrgRows(Resource.OrgTable.name);
  const stats: RunStats = {
    orgs: tallies.size,
    drifted: 0,
    repaired: 0,
    skipped: 0,
    repairFailed: 0,
    noOwner: 0,
  };

  // Sequential, and no org's failure ends the run: one org's counter is
  // independent of every other org's, so a throttled repair costs that org a
  // cycle rather than leaving the rest of the table unchecked.
  for (const [orgId, tally] of tallies) {
    await reconcileOrg(orgId, tally, stats);
  }

  emitRunSummary(stats);
  console.log('[owner-count-drift-checker] complete', stats);
}

/**
 * One paged Scan of the whole table, tallied as it streams.
 *
 * OrgTable holds membership rows, their inverse items, invitation rows and the
 * META rows, so it is small and a Scan reads it for a few RCUs — cheaper than
 * a Query per org, which would need the org list this table has no index for.
 * The projection keeps the read to the four attributes the recount uses, so an
 * invitation row costs its keys and nothing more; `role` needs an expression
 * name because it is a DynamoDB reserved word.
 */
async function scanOrgRows(orgTableName: string): Promise<Map<string, OrgTally>> {
  const tallies = new Map<string, OrgTally>();
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: orgTableName,
        ProjectionExpression: 'pk, sk, #role, ownerCount',
        ExpressionAttributeNames: { '#role': 'role' },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );

    for (const item of result.Items ?? []) tallyRow(item, tallies);

    cursor = result.LastEvaluatedKey;
  } while (cursor);

  return tallies;
}

/**
 * Adds one scanned row to its org's tally, ignoring everything that is not a
 * membership or META row: the `USER#` inverse items carry a denormalized role
 * and would double every count, and the `INVITETOKEN#` partitions are not orgs
 * at all. An `ORG#` partition holding only invitation rows never becomes a
 * tally entry, so the missing-META repair below cannot mint a counter for a
 * partition that has no members.
 */
function tallyRow(item: Record<string, AttributeValue>, tallies: Map<string, OrgTally>): void {
  const pk = item.pk?.S ?? '';
  if (!pk.startsWith(ORG_PK_PREFIX)) return;

  const sk = item.sk?.S ?? '';
  const isMeta = sk === OrgKeys.orgMetaSk();
  const isMember = sk.startsWith(OrgKeys.memberSkPrefix());
  if (!isMeta && !isMember) return;

  const orgId = pk.slice(ORG_PK_PREFIX.length);
  const tally = tallies.get(orgId) ?? { members: 0, owners: 0, hasMeta: false };

  if (isMeta) {
    tally.hasMeta = true;
    tally.storedOwnerCount = readCounter(item.ownerCount, orgId);
  } else {
    tally.members += 1;
    if (isOwnerRow(item.role, orgId, sk)) tally.owners += 1;
  }

  tallies.set(orgId, tally);
}

/**
 * The stored counter, or undefined when the META row carries none.
 *
 * A counter written as anything other than a number reads as absent, which
 * makes the repair below condition on `attribute_not_exists(ownerCount)` and
 * lose — so a mistyped counter is reported every run and left for a human
 * rather than overwritten by a job that cannot tell what it was.
 */
function readCounter(attribute: AttributeValue | undefined, orgId: string): number | undefined {
  if (attribute === undefined) return undefined;

  const value = Number(attribute.N);
  if (attribute.N === undefined || !Number.isFinite(value)) {
    console.error('[owner-count-drift-checker] META row carries a non-numeric ownerCount', {
      orgId,
      ownerCount: attribute,
    });
    return undefined;
  }

  return value;
}

/**
 * Whether a membership row counts toward the owner set. An unrecognized role is
 * not an Owner — it authorizes nothing, the same stance every membership reader
 * takes — and it is logged, because the only way one gets written is a bad
 * write or a conversion that missed a value.
 */
function isOwnerRow(role: AttributeValue | undefined, orgId: string, sk: string): boolean {
  const stored = role?.S ?? '';
  if (!isOrgRole(stored)) {
    console.error('[owner-count-drift-checker] membership row carries an unrecognized role', {
      orgId,
      sk,
      role: stored,
    });
    return false;
  }

  return stored === OrgRole.Owner;
}

/** What a repair writes, and what it found — logged either way. */
interface Repair {
  orgId: string;
  counted: number;
  /** The value the repair is conditioned on; undefined when there was none. */
  stored?: number;
  send: () => Promise<unknown>;
}

async function reconcileOrg(orgId: string, tally: OrgTally, stats: RunStats): Promise<void> {
  const counted = tally.owners;

  if (counted === 0) {
    stats.noOwner += 1;
    console.error('[owner-count-drift-checker] org has no Owner', {
      orgId,
      members: tally.members,
      storedOwnerCount: tally.storedOwnerCount,
    });
  }

  if (!tally.hasMeta) {
    // Only orgs with membership rows get here, so the counter the last-Owner
    // guard reads is missing for an org that has members — the guard's
    // condition cannot fail closed on a row that does not exist.
    console.error('[owner-count-drift-checker] org has membership rows and no META row', {
      orgId,
      members: tally.members,
      counted,
    });
    stats.drifted += 1;
    await applyRepair(
      { orgId, counted, send: () => dynamo.send(createMeta(orgId, counted)) },
      stats,
    );
    return;
  }

  if (tally.storedOwnerCount === counted) return;

  const stored = tally.storedOwnerCount;
  stats.drifted += 1;
  console.log('[owner-count-drift-checker] counter diverged', { orgId, stored, counted });
  await applyRepair(
    { orgId, counted, stored, send: () => dynamo.send(repairCounter(orgId, counted, stored)) },
    stats,
  );
}

/**
 * Writes the recounted value, conditioned on the row still holding what the
 * scan read.
 *
 * The scan and the repair are minutes apart, and an invitation accepted or an
 * Owner demoted in between has already moved the counter by its own delta.
 * Losing the condition therefore means the counter is current and this run's
 * count is stale, which is not a failure — the next run recounts. Anything else
 * is counted so a table that stops reconciling raises an alarm.
 */
async function applyRepair(repair: Repair, stats: RunStats): Promise<void> {
  const { orgId, counted, stored } = repair;

  try {
    await repair.send();
    stats.repaired += 1;
    console.log('[owner-count-drift-checker] counter repaired', { orgId, stored, counted });
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      stats.skipped += 1;
      console.log('[owner-count-drift-checker] repair skipped, the counter moved', {
        orgId,
        stored,
        counted,
      });
      return;
    }

    stats.repairFailed += 1;
    console.error('[owner-count-drift-checker] repair failed', { orgId, stored, counted, error });
  }
}

// Matched on the SDK exception type, with a name fallback for a rejection that
// crossed a client boundary and lost its prototype.
function isConditionalCheckFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error instanceof Error && error.name === 'ConditionalCheckFailedException')
  );
}

function repairCounter(
  orgId: string,
  counted: number,
  stored: number | undefined,
): UpdateItemCommand {
  return new UpdateItemCommand({
    TableName: Resource.OrgTable.name,
    Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.orgMetaSk() } },
    UpdateExpression: 'SET ownerCount = :counted',
    ConditionExpression:
      stored === undefined ? 'attribute_not_exists(ownerCount)' : 'ownerCount = :stale',
    ExpressionAttributeValues: {
      ':counted': { N: String(counted) },
      ...(stored === undefined ? {} : { ':stale': { N: String(stored) } }),
    },
  });
}

// Conditioned on the whole row's absence: an owner-set transaction that created
// the META row while this run was scanning owns the counter, and its value is
// the one built from the rows it wrote.
function createMeta(orgId: string, counted: number): PutItemCommand {
  return new PutItemCommand({
    TableName: Resource.OrgTable.name,
    Item: {
      pk: { S: OrgKeys.orgPk(orgId) },
      sk: { S: OrgKeys.orgMetaSk() },
      ownerCount: { N: String(counted) },
    },
    ConditionExpression: 'attribute_not_exists(pk)',
  });
}

// One envelope per run, with no org id anywhere in it: orgs are unbounded, and
// a per-org dimension would mint a custom metric for each. The org ids are in
// the logs beside the counts, which is where an operator reading an alarm goes.
function emitRunSummary(stats: RunStats): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [
            { Name: 'OwnerCountDrift', Unit: 'Count' },
            { Name: 'OwnerCountRepairFailed', Unit: 'Count' },
            { Name: 'OrgsWithNoOwner', Unit: 'Count' },
          ],
        },
      ],
    },
    OwnerCountDrift: stats.drifted,
    OwnerCountRepairFailed: stats.repairFailed,
    OrgsWithNoOwner: stats.noOwner,
  });
}
