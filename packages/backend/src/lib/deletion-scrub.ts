import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3VectorsStore } from '@filone/rag-shared';
import { SubscriptionStatus, type S3Region } from '@filone/shared';
import { Resource } from 'sst';
import {
  clearCheckpoint,
  deleteManifestEntry,
  loadManifest,
} from '../jobs/rag-indexer-manifest.js';
import { AuditKeys } from './audit.js';
import { getDynamoClient } from './ddb-client.js';
import { collectPages } from './ddb-paging.js';
import { RAGKeys } from './dynamo-records.js';
import { OrgKeys } from './org-membership.js';
import type { DeletionMember } from './deletion-record.js';
import { RagApiKeyKeys } from './rag-api-keys.js';
import { SubscriptionKeys } from './subscription-store.js';

type Item = Record<string, AttributeValue>;

/**
 * Removes an org's personal data. Credentials are destroyed; every row that
 * describes the account is kept, keyed, and stamped with `deletedAt`.
 *
 * Retention is what makes the rest of the design work: the billing fence is one
 * condition because the row is never missing, `createBillingTrial` becomes a
 * permanent no-op instead of minting a fresh Stripe customer, and the profile's
 * `deleting` fence outlives the teardown.
 *
 * Idempotent and resumable. The destroyed rows shrink the partition on each
 * pass; the stamps use `if_not_exists`, so the first pass's time wins.
 *
 * `EMAIL_NORM#{email}` is keyed by an address no retained row stores, and is
 * rekeyed to a hash by its own migration. `WEBHOOK#{eventId}` carries no org
 * attribute and expires on its own TTL. `ALLOWLIST#{email}` is deleted in the
 * Auth0 step, which is the only place its key can still be resolved.
 *
 * The OrgTable rows are destroyed rather than retained. They describe an org
 * that no longer exists, and leaving a membership behind would leave the member
 * able to act in it. They go last, after every step that reads a member has run.
 *
 * The audit partition is destroyed too, which is the one place this file removes
 * a row it could have emptied instead. See {@link destroyAuditPartition}.
 */
export async function scrubOrgRecords(orgId: string, members: DeletionMember[]): Promise<void> {
  const orgRows = await readOrgPartition(orgId);

  // Destroyed first: the lookup keys derive from rows in this partition, and the
  // RagIndexerTable keys are what address the vector indexes.
  await deleteRagKeyLookups(orgRows);
  await purgeRagState(orgId);
  await destroyOrgCredentials(orgRows);

  await scrubBilling(orgId, members);
  await scrubMembers(orgId, members);
  await destroyAuditPartition(orgId);

  // It holds the tenant ids a resumed pass reads, and a failed pass leaves the
  // most context for troubleshooting behind it.
  await scrubOrgProfile(orgId);

  // Last of all: these are the rows a re-driven pass resolves its members from,
  // and every member-dependent step above has to be able to run again.
  await destroyOrgTableRows(orgId, members);
}

/**
 * Read once, used twice: to harvest RAG token hashes and to delete the rows.
 * Enumerating by pk rather than by known sks keeps this correct when someone
 * adds a new sk shape.
 */
async function readOrgPartition(orgId: string): Promise<Item[]> {
  return collectPages((cursor) =>
    getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: marshall({ ':pk': `ORG#${orgId}` }),
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );
}

/**
 * Before the partition: a lookup pk derives from the `tokenHash` on the
 * `RAGKEY#` row, so the other order leaves rows nothing can ever find, each
 * holding the hash of a credential.
 */
async function deleteRagKeyLookups(orgRows: Item[]): Promise<void> {
  for (const row of orgRows) {
    const tokenHash = row.tokenHash?.S;
    if (!tokenHash) continue;
    await deleteRow(Resource.UserInfoTable.name, {
      pk: RagApiKeyKeys.lookupPk(tokenHash),
      sk: RagApiKeyKeys.lookupSk(),
    });
  }
}

/**
 * The orgId is inside the pk and Query needs an exact hash key, so this is the
 * one Scan in the purge — the same shape rag-indexer-orchestrator already runs
 * against this table every pass.
 */
async function purgeRagState(orgId: string): Promise<void> {
  const pks = await collectPages((cursor) =>
    getDynamoClient().send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        FilterExpression: 'begins_with(pk, :bucket) OR begins_with(pk, :checkpoint)',
        ProjectionExpression: 'pk',
        ExpressionAttributeValues: marshall({
          ':bucket': `BUCKET#${orgId}#`,
          ':checkpoint': `INDEXER_CHECKPOINT#${orgId}#`,
        }),
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );

  // Both pk shapes name the same bucket, so dedupe: one purge per bucket.
  const buckets = new Map<string, { region: S3Region; bucketName: string }>();
  for (const row of pks) {
    const pk = row.pk?.S ?? '';
    const parsed = RAGKeys.parseBucketPk(pk) ?? parseCheckpointPk(pk);
    if (parsed) buckets.set(`${parsed.region}#${parsed.bucketName}`, parsed);
  }

  const vectorStore = new S3VectorsStore(Resource.RagVectorBucket.name);
  for (const { region, bucketName } of buckets.values()) {
    await purgeRagBucket(vectorStore, orgId, region, bucketName);
  }
}

async function purgeRagBucket(
  vectorStore: S3VectorsStore,
  orgId: string,
  region: S3Region,
  bucketName: string,
): Promise<void> {
  // deleteManifestEntry rebuilds the sk with the same builder that wrote it, so
  // an objectKey containing '#' round-trips instead of being mangled.
  const manifest = await loadManifest(orgId, region, bucketName);
  for (const objectKey of manifest.keys()) {
    await deleteManifestEntry(orgId, region, bucketName, objectKey);
  }

  await deleteRow(Resource.RagIndexerTable.name, {
    pk: RAGKeys.bucketPk(orgId, region, bucketName),
    sk: RAGKeys.enablementSk(),
  });
  await clearCheckpoint(orgId, region, bucketName);
  await vectorStore.dropIndex(orgId, region, bucketName);
}

/**
 * The card fields are the only personal data on the row. `canceled` is written
 * here rather than left to the cancellation webhook, so the row and Stripe cannot
 * disagree: the Stripe cancel has already succeeded by the time the scrub runs,
 * and the stamp refuses every webhook that arrives afterwards.
 *
 * The org's row carries the fence, because it is the row every reader and writer
 * addresses, and it is stamped for every deletion.
 *
 * A member's pre-re-key `CUSTOMER#` row is stamped only when this deletion also
 * ends their account. The legacy row is keyed by user, so it belongs to the
 * member's own personal org; an invited member keeps that org and its billing,
 * and stamping their row here would fence a subscription this deletion has no
 * claim on. Where the row is stamped it keeps the old fence closed until the
 * runbook's dated cleanup step deletes those rows; a row that is already gone
 * makes its own stamp a no-op.
 *
 * `stripeCustomerId` and `subscriptionId` are system identifiers and stay.
 */
async function scrubBilling(orgId: string, members: DeletionMember[]): Promise<void> {
  await scrubSubscriptionRow(SubscriptionKeys.orgPk(orgId));
  for (const { userId, deleteIdentity } of members) {
    if (!deleteIdentity) continue;
    await scrubSubscriptionRow(SubscriptionKeys.legacyPk(userId));
  }
}

async function scrubSubscriptionRow(pk: string): Promise<void> {
  await scrubRow({
    tableName: Resource.BillingTable.name,
    key: { pk, sk: SubscriptionKeys.sk() },
    set: 'subscriptionStatus = :canceled, updatedAt = :now',
    remove:
      'paymentMethodId, paymentMethodLast4, paymentMethodBrand, ' +
      'paymentMethodExpMonth, paymentMethodExpYear, gracePeriodEndsAt',
    values: { ':canceled': SubscriptionStatus.Canceled },
  });
}

/**
 * Credentials only. A scrubbed credential row is still a credential row, so
 * retention buys nothing; the RAG lookup row cannot be scrubbed at all, since its
 * delete path conditions on `orgId`.
 *
 * Enumerating by pk keeps this correct as sk shapes are added, at the cost of
 * destroying an unrecognised one — so any new row that describes the org rather
 * than granting access to it has to be named in the skip list.
 */
async function destroyOrgCredentials(orgRows: Item[]): Promise<void> {
  for (const row of orgRows) {
    const sk = row.sk?.S;
    if (!sk || sk === 'DELETION' || sk === 'PROFILE' || sk.startsWith('MEMBER#')) continue;
    await deleteItem(Resource.UserInfoTable.name, { pk: row.pk!, sk: row.sk! });
  }
}

/**
 * None of these three rows carries personal data, so the scrub is a bare stamp.
 *
 * The identity row keeps `userId` and `orgId`: auth branches on the row holding
 * both, and a row stripped of them falls through to the new-user path, which mints
 * fresh ids and then cancels its own transaction against the still-present key —
 * a 500 on every login instead of a clean refusal. The user profile keeps `sub`,
 * the audit correlation key, which outlives the Auth0 user.
 *
 * The first two rows are the member's account, so they are stamped only for a
 * member whose account this deletion ends (`deleteIdentity`). A member who was
 * invited here, or who belongs to another org, still logs in tomorrow, and a
 * `deletedAt` on their identity row would say otherwise. That member's rows are
 * re-pointed instead. The legacy membership row is stamped either way: it
 * belongs to this org.
 */
async function scrubMembers(orgId: string, members: DeletionMember[]): Promise<void> {
  for (const member of members) {
    if (member.deleteIdentity) {
      await scrubRow({ key: { pk: `SUB#${member.sub}`, sk: 'IDENTITY' } });
      await scrubRow({ key: { pk: `USER#${member.userId}`, sk: 'PROFILE' } });
    } else {
      await repointHomeOrg(orgId, member);
    }
    await scrubRow({ key: { pk: `ORG#${orgId}`, sk: `MEMBER#${member.userId}` } });
  }
}

/**
 * Moves a surviving member's home org to one they still belong to.
 *
 * Both rows name the org the member logs in to: `authMiddleware` reads the orgId
 * off the identity row and refuses the request when that org is deleting, before
 * any `X-Org-Id` header is looked at. A member left naming this org would keep
 * their Auth0 user and their rows and still be refused on every request.
 *
 * `homeOrgId` is absent when the member has no other membership to move to —
 * an invited sole member, whose account survives with nowhere to send it. The
 * rows are left as they are; there is no org to name.
 *
 * Both writes are conditioned on the row still naming the deleting org, so a
 * re-drive after the move lands on a row that no longer matches and changes
 * nothing.
 */
async function repointHomeOrg(orgId: string, member: DeletionMember): Promise<void> {
  const { homeOrgId } = member;
  if (!homeOrgId) return;
  await repointRow({ pk: `SUB#${member.sub}`, sk: 'IDENTITY' }, orgId, homeOrgId);
  await repointRow({ pk: `USER#${member.userId}`, sk: 'PROFILE' }, orgId, homeOrgId);
}

async function repointRow(
  key: Record<string, string>,
  deletingOrgId: string,
  homeOrgId: string,
): Promise<void> {
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall(key),
        UpdateExpression: 'SET orgId = :home',
        ConditionExpression: 'attribute_exists(pk) AND orgId = :deleting',
        ExpressionAttributeValues: marshall({ ':home': homeOrgId, ':deleting': deletingOrgId }),
      }),
    );
  } catch (err) {
    // The row is gone or already moved. Either way there is nothing to do.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

/**
 * The invite token lookup, `INVITETOKEN#{sha256(token)}` / `LOOKUP`. Its key
 * builders arrive with invitations; the shape is mirrored here so an invitation
 * outstanding on the day an org is deleted takes its lookup row with it.
 */
const INVITE_SK_PREFIX = 'INVITE#';
const inviteTokenLookupKey = (tokenHash: string): Record<string, string> => ({
  pk: `INVITETOKEN#${tokenHash}`,
  sk: 'LOOKUP',
});

/**
 * Everything the org owns in OrgTable: the membership rows, the `META` counter,
 * any invitation rows, and each member's `USER#{userId}/MEMBERSHIP#{orgId}`
 * inverse item.
 *
 * The membership rows go last, both within this step and across the scrub as a
 * whole. Teardown resolves its member list from them, so a pass that dies
 * partway through leaves the rows a re-drive reads to resolve the same members
 * again — the same reason the UserInfoTable `MEMBER#` rows are retained rather
 * than destroyed.
 */
async function destroyOrgTableRows(orgId: string, members: DeletionMember[]): Promise<void> {
  const orgTable = Resource.OrgTable.name;
  const rows = await readOrgTablePartition(orgId);
  const memberRows = rows.filter(isMemberRow);

  // Before the invitation rows that name them, for the same reason the RAG
  // lookups go first: the lookup key derives from the row's `tokenHash`.
  await deleteInviteTokenLookups(rows);

  for (const row of rows.filter((candidate) => !isMemberRow(candidate))) {
    await deleteItem(orgTable, { pk: row.pk!, sk: row.sk! });
  }

  // Parsed the way the census parses it, not sliced: a `MEMBER#` row with no id
  // after the prefix would otherwise yield an empty user id and send a delete at
  // `USER#`, a partition this org does not own.
  const userIds = new Set([
    ...memberRows
      .map((row) => OrgKeys.parseMemberSk(row.sk?.S))
      .filter((userId): userId is string => userId !== undefined),
    ...members.map((member) => member.userId),
  ]);
  for (const userId of userIds) {
    await deleteRow(orgTable, { pk: OrgKeys.userPk(userId), sk: OrgKeys.membershipSk(orgId) });
  }

  for (const row of memberRows) {
    await deleteItem(orgTable, { pk: row.pk!, sk: row.sk! });
  }
}

function isMemberRow(row: Item): boolean {
  return row.sk?.S?.startsWith(OrgKeys.memberSkPrefix()) === true;
}

/**
 * Enumerated by pk rather than by known sks, so a row shape added later is
 * destroyed with the rest instead of outliving the org silently.
 */
async function readOrgTablePartition(orgId: string): Promise<Item[]> {
  return collectPages((cursor) =>
    getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.OrgTable.name,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: marshall({ ':pk': OrgKeys.orgPk(orgId) }),
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );
}

/**
 * Every audit event the org ever produced, destroyed rather than emptied.
 *
 * An event's personal data is `actor.email` and the addresses on the invitation
 * payloads, and both sit in the row body. Emptying them means rewriting stored
 * events, which contradicts the append-only claim further than removing them
 * does — the same reason credential rows and `RagIndexerTable` are destroyed
 * here instead of stamped. Without this step an org's full record of who
 * belonged to it and what they did outlives the org by up to 90 days, until the
 * TTL reaches it.
 *
 * The account deletion worker is the one credential in the system holding
 * `DeleteItem` on this table; every route's grant stops at `PutItem` and
 * `Query`.
 *
 * Enumerated by pk, like the two partitions above, so an event type added later
 * is destroyed with the rest.
 */
async function destroyAuditPartition(orgId: string): Promise<void> {
  const auditTable = Resource.AuditLog.name;
  const events = await collectPages((cursor) =>
    getDynamoClient().send(
      new QueryCommand({
        TableName: auditTable,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: marshall({ ':pk': AuditKeys.orgPk(orgId) }),
        // The events of the mutations this teardown just made are the ones most
        // likely to be missed by an eventually consistent read.
        ConsistentRead: true,
        ProjectionExpression: 'pk, sk',
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );

  for (const event of events) {
    await deleteItem(auditTable, { pk: event.pk!, sk: event.sk! });
  }
}

/**
 * An invitation row that stores no `tokenHash` leaves its lookup row in place:
 * the lookup pk is the hash, and without it the row cannot be addressed. Nothing
 * reclaims it — OrgTable has no TTL, and invite expiry is a comparison made when
 * the accept link is read, not a row that disappears. The row holds the hash of
 * a token whose invitation is gone, so accepting it resolves to nothing.
 */
async function deleteInviteTokenLookups(orgRows: Item[]): Promise<void> {
  for (const row of orgRows) {
    if (!row.sk?.S?.startsWith(INVITE_SK_PREFIX)) continue;
    const tokenHash = row.tokenHash?.S;
    if (!tokenHash) continue;
    await deleteRow(Resource.OrgTable.name, inviteTokenLookupKey(tokenHash));
  }
}

/** `name` is the org's only personal data. `deleting` stays, permanently. */
async function scrubOrgProfile(orgId: string): Promise<void> {
  await scrubRow({
    key: { pk: `ORG#${orgId}`, sk: 'PROFILE' },
    remove: '#name',
    names: { '#name': 'name' },
  });
}

/**
 * One stamped update. `if_not_exists` keeps the first pass's time across re-runs,
 * and `attribute_exists(pk)` stops a re-run recreating a row someone else removed
 * — a bare `UpdateItem` would upsert one holding nothing but a stamp.
 */
async function scrubRow(params: {
  tableName?: string;
  key: Record<string, string>;
  set?: string;
  remove?: string;
  values?: Record<string, unknown>;
  names?: Record<string, string>;
}): Promise<void> {
  const set = ['deletedAt = if_not_exists(deletedAt, :now)', params.set].filter(Boolean).join(', ');
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: params.tableName ?? Resource.UserInfoTable.name,
        Key: marshall(params.key),
        UpdateExpression: `SET ${set}${params.remove ? ` REMOVE ${params.remove}` : ''}`,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: marshall({
          ':now': new Date().toISOString(),
          ...params.values,
        }),
        ...(params.names ? { ExpressionAttributeNames: params.names } : {}),
      }),
    );
  } catch (err) {
    // Nothing to scrub: a member who never onboarded has no billing row.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

function parseCheckpointPk(
  pk: string,
): { region: S3Region; bucketName: string; orgId: string } | undefined {
  if (!pk.startsWith('INDEXER_CHECKPOINT#')) return undefined;
  return RAGKeys.parseBucketPk(pk.replace('INDEXER_CHECKPOINT#', 'BUCKET#'));
}

async function deleteRow(tableName: string, key: Record<string, string>): Promise<void> {
  await deleteItem(tableName, marshall(key));
}

async function deleteItem(tableName: string, key: Item): Promise<void> {
  await getDynamoClient().send(new DeleteItemCommand({ TableName: tableName, Key: key }));
}
