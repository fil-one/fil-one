import {
  ConditionalCheckFailedException,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { OrgRole, isOrgRole } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { reportMetric } from '../lib/metrics.js';
import { OWNER_SET_REV_ATTRIBUTE } from '../lib/membership-changes.js';
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
 *
 * The Scan is a trigger, never the evidence. A Scan is not a snapshot: it reads
 * each item at whatever moment it reaches it, so a transaction that promotes one
 * member and demotes another can be half-observed, and an org whose rows straddle
 * a page boundary can be counted across minutes. A repair written from that is a
 * repair written from a count no instant ever held — and the direction that
 * matters is upward, because an inflated counter defeats the `ownerCount > :one`
 * guard and lets the last Owner be removed. So every repair recounts the org's
 * own partition with a ConsistentRead Query first, and writes what THAT says,
 * conditioned on the counter it read a moment earlier.
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
  /**
   * The owner-set revision on the META row the recount read. Undefined for a row
   * written before the attribute existed, which is the same as "nothing has
   * moved the owner set since".
   */
  ownerSetRev?: number;
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
 * Adds one scanned row to its org's tally. An `ORG#` partition holding only
 * invitation rows never becomes a tally entry, so the missing-META repair below
 * cannot mint a counter for a partition that has no members.
 */
function tallyRow(item: Record<string, AttributeValue>, tallies: Map<string, OrgTally>): void {
  const pk = item.pk?.S ?? '';
  if (!pk.startsWith(ORG_PK_PREFIX)) return;

  const orgId = pk.slice(ORG_PK_PREFIX.length);
  const tally = tallies.get(orgId) ?? { members: 0, owners: 0, hasMeta: false };
  if (addRow(item, orgId, tally)) tallies.set(orgId, tally);
}

/**
 * Adds one row to an org's tally, and says whether it was one this job counts.
 *
 * Shared by the Scan and the per-org recount so the two can never disagree about
 * what an Owner row is. Everything that is not a membership or META row is
 * ignored: the `USER#` inverse items carry a denormalized role and would double
 * every count, the `INVITETOKEN#` partitions are not orgs, and an invitation row
 * sits in the org's own partition carrying a role that is nobody's membership.
 */
function addRow(item: Record<string, AttributeValue>, orgId: string, tally: OrgTally): boolean {
  const sk = item.sk?.S ?? '';
  const isMeta = sk === OrgKeys.orgMetaSk();
  const isMember = sk.startsWith(OrgKeys.memberSkPrefix());
  if (!isMeta && !isMember) return false;

  if (isMeta) {
    tally.hasMeta = true;
    tally.storedOwnerCount = readCounter(item.ownerCount, orgId);
    const rev = Number(item[OWNER_SET_REV_ATTRIBUTE]?.N);
    if (Number.isFinite(rev)) tally.ownerSetRev = rev;
  } else {
    tally.members += 1;
    if (isOwnerRow(item.role, orgId, sk)) tally.owners += 1;
  }

  return true;
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

/**
 * One org's rows, read consistently, in one Query of its partition.
 *
 * Everything the repair decides comes from here rather than from the Scan: a
 * Query of one partition with `ConsistentRead` returns rows that were all
 * current at the same moment, which is exactly what a count the guard depends on
 * has to be. Paged, because a Query returns at most 1 MB.
 */
async function recountOrg(orgId: string): Promise<OrgTally> {
  const tally: OrgTally = { members: 0, owners: 0, hasMeta: false };
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: Resource.OrgTable.name,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: OrgKeys.orgPk(orgId) } },
        // The revision comes back with the counter here and not in the Scan:
        // this is the reading the repair conditions on, and it is what says
        // whether the owner set moved while these pages were being read.
        ProjectionExpression: `pk, sk, #role, ownerCount, ${OWNER_SET_REV_ATTRIBUTE}`,
        ExpressionAttributeNames: { '#role': 'role' },
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );

    for (const item of result.Items ?? []) addRow(item, orgId, tally);

    cursor = result.LastEvaluatedKey;
  } while (cursor);

  return tally;
}

async function reconcileOrg(orgId: string, scanned: OrgTally, stats: RunStats): Promise<void> {
  // Nothing to look at: the Scan saw a counter that matched a non-zero owner
  // set, which is the shape of an org that is fine. Everything else is
  // re-examined properly before a word is said about it.
  if (scanned.hasMeta && scanned.storedOwnerCount === scanned.owners && scanned.owners > 0) return;

  let tally: OrgTally;
  try {
    tally = await recountOrg(orgId);
  } catch (error) {
    stats.repairFailed += 1;
    console.error('[owner-count-drift-checker] recount failed — org left for the next run', {
      orgId,
      error,
    });
    return;
  }

  const counted = tally.owners;

  if (counted === 0 && tally.members > 0) {
    stats.noOwner += 1;
    console.error('[owner-count-drift-checker] org has no Owner', {
      orgId,
      members: tally.members,
      storedOwnerCount: tally.storedOwnerCount,
    });
  }

  if (!tally.hasMeta) {
    // A partition whose member rows have all gone gets no counter invented for
    // it; an org that still has members and no META row has a last-Owner guard
    // that cannot fail closed, because its condition reads a row that is not
    // there.
    if (tally.members === 0) return;

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

  // The Scan's disagreement did not survive the recount: the counter is current
  // and the Scan's count was stale, which is the ordinary case for an org whose
  // membership changed while the table was being read.
  if (tally.storedOwnerCount === counted) return;

  const stored = tally.storedOwnerCount;
  stats.drifted += 1;
  console.log('[owner-count-drift-checker] counter diverged', { orgId, stored, counted });
  await applyRepair(
    {
      orgId,
      counted,
      stored,
      send: () => dynamo.send(repairCounter(orgId, counted, stored, tally.ownerSetRev)),
    },
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
    // Its own data point rather than a number in the run summary: a repair means
    // some write path left the counter wrong, and an alarm on "this happened at
    // all" is the one an operator wants. The org id stays in the log line beside
    // it — orgs are unbounded, and a per-org dimension would mint a custom
    // metric for each.
    emitRepair();
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

/**
 * The repair, conditioned on nothing having moved the owner set since the
 * recount read it.
 *
 * The counter alone is not enough. A transfer's META update is net zero, so
 * `ownerCount = :stale` still holds while the recount's paged Query observed the
 * transfer half applied — at zero Owners, or at two, which would inflate the
 * counter and defeat the `ownerCount > :one` last-Owner guard. The revision moves
 * on every owner-set write including that one, so conditioning on it makes any
 * concurrent change skip the repair; the next run recounts and converges.
 *
 * A row with no revision yet is one no owner-set transaction has touched since
 * the attribute shipped, so its absence is the condition.
 */
function repairCounter(
  orgId: string,
  counted: number,
  stored: number | undefined,
  ownerSetRev: number | undefined,
): UpdateItemCommand {
  const counterCondition =
    stored === undefined ? 'attribute_not_exists(ownerCount)' : 'ownerCount = :stale';
  const revCondition =
    ownerSetRev === undefined
      ? `attribute_not_exists(${OWNER_SET_REV_ATTRIBUTE})`
      : `${OWNER_SET_REV_ATTRIBUTE} = :rev`;

  return new UpdateItemCommand({
    TableName: Resource.OrgTable.name,
    Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.orgMetaSk() } },
    UpdateExpression: 'SET ownerCount = :counted',
    ConditionExpression: `${counterCondition} AND ${revCondition}`,
    ExpressionAttributeValues: {
      ':counted': { N: String(counted) },
      ...(stored === undefined ? {} : { ':stale': { N: String(stored) } }),
      ...(ownerSetRev === undefined ? {} : { ':rev': { N: String(ownerSetRev) } }),
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

function emitRepair(): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'OwnerCountRepaired', Unit: 'Count' }],
        },
      ],
    },
    OwnerCountRepaired: 1,
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
