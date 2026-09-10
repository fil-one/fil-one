import { createHash, randomBytes } from 'node:crypto';
import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { INVITATION_STATUSES, INVITE_EXPIRY_DAYS, isOrgRole } from '@filone/shared';
import type { InvitationStatus, InvitationSummary, OrgRole } from '@filone/shared';
import { TRANSACT_WRITE_ITEM_LIMIT } from './audit.js';
import { getDynamoClient } from './ddb-client.js';
import { OrgKeys } from './org-membership.js';

/**
 * The invitation record and its lifecycle: two OrgTable rows per invitation,
 * written and deleted together.
 *
 * - `ORG#{orgId}` / `INVITE#{inviteId}` — the canonical row. It holds the
 *   invited address, the role, who issued it, a status, and an expiry, plus the
 *   token's SHA-256. Never the token.
 * - `INVITETOKEN#{sha256(token)}` / `LOOKUP` — the inverse item an accept link
 *   resolves through, the same idiom as `RAGKEYHASH#…/LOOKUP`
 *   (`lib/rag-api-keys.ts`) and for the same reason: the table has no GSIs, so
 *   the only way to find a row by something other than its key is to make that
 *   something a key.
 *
 * Two properties are worth naming because the whole design turns on them.
 *
 * The token is single-use, and what makes it so is a pair of writes rather than
 * a flag: accepting deletes the lookup row and marks the canonical row accepted
 * under `ConditionExpression: status = :pending`, both inside one
 * `TransactWriteItems`. A second attempt with the same token finds no lookup row.
 *
 * Expiry is a read-time comparison against `expiresAt`, not a TTL. A TTL delete
 * would erase the record before the M2 audit export could see that the
 * invitation was ever issued, and the row is what tells an operator why nobody
 * joined.
 *
 * One address holds at most one live invitation. Inviting an address that
 * already has one revokes it in the same transaction that writes the new one
 * (`handlers/create-invitation.ts`), which is what makes re-inviting the whole
 * recovery story: a send that failed, a link somebody lost, a role somebody
 * mistyped are all fixed by inviting again, and none of them leaves a second
 * usable token or occupies a second slot under the cap.
 *
 * Revoking the row it replaces cannot serialize two FIRST invitations to an
 * address, though: there is nothing to revoke, both transactions write only
 * create-only keys on freshly minted ids, and both land — two working tokens,
 * possibly at two different roles. The address claim
 * (`ORG#{orgId}` / `INVITEADDR#{emailNorm}`, {@link inviteAddressClaimItem}) is
 * the item they collide on.
 *
 * The record is transport-independent on purpose: nothing here mentions the
 * mailer. An SSO-era switch to Auth0-delivered invitations replaces the send and
 * the token and leaves this lifecycle — including the inviter re-check and the
 * `ownerCount` arithmetic in `lib/membership-changes.ts` — untouched.
 */

/** OrgTable — pk: ORG#{orgId}, sk: INVITE#{inviteId} (unmarshalled shape). */
export interface InvitationRecord {
  orgId: string;
  inviteId: string;
  /** The address as the inviter typed it: what the email went to, and what the console shows. */
  email: string;
  /**
   * The address lowercased, which is what an accepting session's verified email
   * is compared against. Stored beside the typed form rather than derived on
   * read, so the comparison never depends on the reader repeating the rule.
   */
  emailNorm: string;
  role: OrgRole;
  invitedBy: string;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  /**
   * SHA-256 of the token, the address of the lookup row. Held here so revoking
   * and accepting can delete that row without the token — exactly what
   * `RagKeyRecord.tokenHash` is for.
   */
  tokenHash: string;
  /**
   * The send after the row landed did not reach SendGrid. Stamped best-effort
   * after the fact rather than written with the row, because the row is the
   * invitation and the send is a later, separate outcome — and it is what lets
   * the pending list tell a dead row from one the recipient is ignoring.
   */
  lastSendFailed?: boolean;
}

/**
 * The invited address, lowercased.
 *
 * Deliberately NOT `normalizeEmailForEntitlement`: that function collapses
 * distinct addresses (dropping `+tags`, and dots for Gmail) because it is a
 * uniqueness key for the trial entitlement, and its own doc says never to reuse
 * it. An invitation is the opposite question — did this session's verified
 * address receive this invitation — so the only safe normalization is the one
 * that changes nothing but case, which is also what the beta allowlist key uses
 * (`middleware/rag-access.ts`).
 */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A fresh invitation token: 32 random bytes, base64url — 256 bits of entropy. */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage and lookup. Unsalted SHA-256, as with RAG keys: the
 * input is a 256-bit random value rather than a guessable secret, and equal
 * tokens have to reach equal keys for the lookup to work at all.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** When an invitation issued at `createdAt` stops being acceptable. */
export function inviteExpiresAt(createdAt: string): string {
  return new Date(
    new Date(createdAt).getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/** Whether the row is one a token may still be redeemed against. */
export function isInvitationUsable(record: InvitationRecord, now = new Date()): boolean {
  return record.status === 'pending' && !isInvitationExpired(record, now);
}

/** Whether the row's expiry has passed, whatever its status says. */
export function isInvitationExpired(record: InvitationRecord, now = new Date()): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  // An unparseable expiry is treated as expired rather than as forever: the only
  // way one gets stored is a bad write, and the safe reading of "we do not know
  // when this stops being valid" is that it already has.
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime();
}

/** The wire shape, with `expired` computed here so the console never does date math. */
export function invitationSummary(record: InvitationRecord, now = new Date()): InvitationSummary {
  return {
    inviteId: record.inviteId,
    email: record.email,
    role: record.role,
    invitedBy: record.invitedBy,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status,
    expired: isInvitationExpired(record, now),
    ...(record.lastSendFailed ? { lastSendFailed: true } : {}),
  };
}

/**
 * One stored row as a record, or undefined when it is not one.
 *
 * A row whose role or status is not in the vocabulary is dropped rather than
 * coerced: an invitation carrying an unrecognized role would either grant
 * nothing or, worse, be managed under the wrong ceiling. Both drops are logged
 * with the offending value, because the only way one gets written is a bad write.
 */
function toInvitationRecord(
  item: Record<string, AttributeValue>,
  orgId: string,
): InvitationRecord | undefined {
  const inviteId = OrgKeys.parseInviteSk(item.sk?.S ?? '');
  if (!inviteId) return undefined;

  const { pk: _pk, sk: _sk, ...attributes } = unmarshall(item);
  const stored = attributes as Partial<InvitationRecord>;
  const role = stored.role ?? '';
  const status = stored.status ?? '';

  if (!isOrgRole(role) || !isInvitationStatus(status)) {
    console.error('[invitations] Invitation row carries an unrecognized value — dropped', {
      orgId,
      inviteId,
      role,
      status,
    });
    return undefined;
  }

  return {
    email: '',
    emailNorm: '',
    invitedBy: '',
    createdAt: '',
    expiresAt: '',
    tokenHash: '',
    ...stored,
    orgId,
    inviteId,
    role,
    status,
  };
}

function isInvitationStatus(value: string): value is InvitationStatus {
  return (INVITATION_STATUSES as readonly string[]).includes(value);
}

/**
 * One invitation by id, read consistently — a revoke that lands moments before
 * this read must not still look pending to the caller deciding what to write.
 */
export async function readInvitation(
  orgId: string,
  inviteId: string,
): Promise<InvitationRecord | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.inviteSk(inviteId) } },
      ConsistentRead: true,
    }),
  );
  return Item ? toInvitationRecord(Item, orgId) : undefined;
}

/**
 * The invitation a raw token names, or undefined when the token resolves to
 * nothing.
 *
 * Two consistent reads, hash → lookup → canonical row, the shape
 * `findRagKeyByToken` uses. Consistent because the lookup row's deletion is what
 * makes a token single-use: an eventually-consistent read of a row deleted
 * seconds ago would let the same token in twice.
 *
 * Undefined covers every miss — unknown, revoked, expired, already accepted —
 * and the caller answers all of them the same way. Nothing here logs the token
 * or its hash: the hash IS the lookup key.
 */
export async function resolveInvitationByToken(
  token: string,
): Promise<InvitationRecord | undefined> {
  const dynamo = getDynamoClient();
  const tokenHash = hashInviteToken(token);

  const lookup = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.OrgTable.name,
      Key: {
        pk: { S: OrgKeys.inviteTokenPk(tokenHash) },
        sk: { S: OrgKeys.inviteTokenSk() },
      },
      ConsistentRead: true,
    }),
  );

  const orgId = lookup.Item?.orgId?.S;
  const inviteId = lookup.Item?.inviteId?.S;
  if (!orgId || !inviteId) return undefined;

  const record = await readInvitation(orgId, inviteId);
  if (!record) {
    // Unreachable through the handlers: both rows are written and deleted in one
    // transaction. Logged by id, never by hash.
    console.error('[invitations] Orphaned INVITETOKEN lookup row — invitation row missing', {
      orgId,
      inviteId,
    });
  }
  return record;
}

/**
 * The point at which an org's invitation partition stops being explicable.
 *
 * Not a page size and not a display limit: the walk below pages to exhaustion,
 * because every consumer of this list is a correctness gate. The pending filter
 * decides what an operator can revoke, the cap decides whether another
 * invitation may be issued, and the demotion and removal sweeps decide which
 * links stop working — all three read a subset in ascending-UUID order, which
 * correlates with neither status nor age, so a silent truncation makes each of
 * them quietly wrong.
 *
 * The bound that remains is a circuit breaker set far above any plausible org:
 * a partition holding this many rows is a bug or an attack, and hitting it
 * throws rather than returning a partial answer. Failing the request is the only
 * safe reading — a gate computed from part of the list is worse than no answer.
 */
const INVITATION_ROW_LIMIT = 20_000;

/** Thrown when an org's invitation partition exceeds {@link INVITATION_ROW_LIMIT}. */
export class InvitationListTooLargeError extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(`Organization ${orgId} holds more than ${INVITATION_ROW_LIMIT} invitation rows`);
    this.name = 'InvitationListTooLargeError';
    this.orgId = orgId;
  }
}

/** Every invitation row in an org, whatever its status. */
export async function listInvitations(orgId: string): Promise<InvitationRecord[]> {
  const invitations: InvitationRecord[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.OrgTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: OrgKeys.orgPk(orgId) },
          ':skPrefix': { S: OrgKeys.inviteSkPrefix() },
        },
        // Consistent: the cap is enforced off this list, and an invitation
        // written moments ago has to count against it.
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

    for (const item of Items ?? []) {
      const record = toInvitationRecord(item, orgId);
      if (record) invitations.push(record);
    }

    if (invitations.length > INVITATION_ROW_LIMIT) {
      console.error('[invitations] Invitation partition is beyond any plausible org', {
        orgId,
        limit: INVITATION_ROW_LIMIT,
      });
      throw new InvitationListTooLargeError(orgId);
    }

    startKey = LastEvaluatedKey;
  } while (startKey);

  return invitations;
}

/** The org's invitations a token could still be redeemed against. */
export async function listUsableInvitations(
  orgId: string,
  now = new Date(),
): Promise<InvitationRecord[]> {
  return (await listInvitations(orgId)).filter((record) => isInvitationUsable(record, now));
}

/**
 * Which of a set of invitations one member issued.
 *
 * A filter over a list the caller already holds, because the three sweeps that
 * need it — demotion, removal, and re-inviting an address — all start from the
 * same read of the org's usable invitations and would otherwise walk the
 * partition once each.
 */
export function invitationsFrom(
  invitations: InvitationRecord[],
  invitedBy: string,
): InvitationRecord[] {
  return invitations.filter((record) => record.invitedBy === invitedBy);
}

/**
 * Which of them were addressed to one email address, already normalized.
 *
 * `emailNorm` rather than the typed form, for the reason the row stores both:
 * the address is matched, not displayed, and case is the only difference the
 * comparison may ignore.
 */
export function invitationsTo(
  invitations: InvitationRecord[],
  emailNorm: string,
): InvitationRecord[] {
  return invitations.filter((record) => record.emailNorm === emailNorm);
}

/**
 * The pending invitations one member issued.
 *
 * Read when that member is demoted or removed, because an invitation must not
 * outlive its issuer's authority: the accept path's `ConditionCheck` on the
 * inviter's row is the backstop, and revoking the invitations is what stops a
 * link that will never work from sitting in somebody's inbox for a fortnight.
 */
export async function pendingInvitationsFrom(
  orgId: string,
  invitedBy: string,
  now = new Date(),
): Promise<InvitationRecord[]> {
  return invitationsFrom(await listUsableInvitations(orgId, now), invitedBy);
}

/**
 * Every usable invitation a removal has to retire, from one read of the
 * partition.
 *
 * Two families, and the second is the one that matters. Invitations the member
 * ISSUED go because no role of theirs remains to justify them. Invitations
 * addressed TO them go because their token still works: a removed member holding
 * an old link redeems it and walks back in at the role that link carries, which
 * for a stale Owner invitation means re-entering as Owner after being demoted
 * and removed. Nothing else on the accept path refuses it — the invitee's email
 * still matches, and the inviter is still an Admin or Owner.
 *
 * Deduplicated by id, because a member who invited themselves is in both.
 */
export async function pendingInvitationsForRemoval(
  orgId: string,
  { userId, emailNorm }: { userId: string; emailNorm?: string },
  now = new Date(),
): Promise<InvitationRecord[]> {
  const usable = await listUsableInvitations(orgId, now);
  const doomed = new Map<string, InvitationRecord>();

  for (const record of invitationsFrom(usable, userId)) doomed.set(record.inviteId, record);
  if (emailNorm) {
    for (const record of invitationsTo(usable, emailNorm)) doomed.set(record.inviteId, record);
  }

  return [...doomed.values()];
}

/**
 * The two rows an invitation is, both create-only.
 *
 * Create-only on the canonical row because the id is freshly minted, and on the
 * lookup row because a token collision is not a thing that happens to 256 random
 * bits — if it ever did, the write must fail rather than repoint an existing
 * token at a different org.
 */
export function invitationRows(record: InvitationRecord): TransactWriteItem[] {
  const tableName = Resource.OrgTable.name;

  return [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: OrgKeys.orgPk(record.orgId) },
          sk: { S: OrgKeys.inviteSk(record.inviteId) },
          email: { S: record.email },
          emailNorm: { S: record.emailNorm },
          role: { S: record.role },
          invitedBy: { S: record.invitedBy },
          status: { S: record.status },
          createdAt: { S: record.createdAt },
          expiresAt: { S: record.expiresAt },
          tokenHash: { S: record.tokenHash },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: OrgKeys.inviteTokenPk(record.tokenHash) },
          sk: { S: OrgKeys.inviteTokenSk() },
          orgId: { S: record.orgId },
          inviteId: { S: record.inviteId },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
  ];
}

/**
 * The one item every invitation to an address writes: a compare-and-swap on the
 * invitation that currently holds it.
 *
 * Two concurrent first invitations to one address otherwise both commit. The
 * cap is computed from a read, the rows they write are create-only on ids each
 * request minted itself, and the retirement that makes re-inviting safe has
 * nothing to retire — so nothing in either transaction names an item the other
 * one touches. This row does, and DynamoDB serializes the two.
 *
 * Compare-and-swap rather than create-only, because the claim outlives the
 * invitation that made it. An invitation expires with no transaction at all —
 * expiry is a read-time comparison, by design, so no writer is there to release
 * the address — and revoked and accepted invitations are retired by
 * transactions this row must not join: replacing a live invitation would then
 * mean deleting and putting the same item in one transaction, which DynamoDB
 * refuses outright. So the claim is never released. The caller reads what it
 * holds ({@link readInviteAddressClaim}) and conditions on that reading, which
 * admits every legitimate re-invitation — expired, revoked, accepted, replaced —
 * and refuses only an invitation that raced another one to the same address.
 *
 * The row is destroyed with the rest of the org's partition at teardown, which
 * enumerates by pk rather than by known sort keys.
 */
export function inviteAddressClaimItem({
  record,
  claimedInviteId,
  now = new Date(),
}: {
  record: InvitationRecord;
  /** The invitation the claim named when it was read; undefined for none. */
  claimedInviteId?: string;
  now?: Date;
}): TransactWriteItem {
  return {
    Put: {
      TableName: Resource.OrgTable.name,
      Item: {
        pk: { S: OrgKeys.orgPk(record.orgId) },
        sk: { S: OrgKeys.inviteAddrSk(record.emailNorm) },
        inviteId: { S: record.inviteId },
        claimedAt: { S: now.toISOString() },
      },
      ...(claimedInviteId === undefined
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : {
            ConditionExpression: 'inviteId = :claimed',
            ExpressionAttributeValues: { ':claimed': { S: claimedInviteId } },
          }),
    },
  };
}

/**
 * Which invitation currently holds an address, or undefined when none ever has.
 *
 * Consistent, because it is the value the claim's condition is written against:
 * a replica that has not caught up with a claim written moments ago would have
 * the caller condition on its absence and lose the write it was meant to win.
 */
export async function readInviteAddressClaim(
  orgId: string,
  emailNorm: string,
): Promise<string | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.OrgTable.name,
      Key: {
        pk: { S: OrgKeys.orgPk(orgId) },
        sk: { S: OrgKeys.inviteAddrSk(emailNorm) },
      },
      ProjectionExpression: 'inviteId',
      ConsistentRead: true,
    }),
  );
  return Item?.inviteId?.S;
}

/**
 * Move a pending invitation to a terminal status.
 *
 * Conditional on it still being pending, which is what makes a revoke racing an
 * accept produce a clean loser: one of the two transactions cancels on this
 * condition and its handler answers for the entity it was writing, rather than
 * both landing and the log claiming an invitation was revoked after it was used.
 */
export function invitationStatusItem(
  record: InvitationRecord,
  status: Exclude<InvitationStatus, 'pending'>,
): TransactWriteItem {
  return {
    Update: {
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.orgPk(record.orgId) }, sk: { S: OrgKeys.inviteSk(record.inviteId) } },
      UpdateExpression: 'SET #status = :status',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': { S: status }, ':pending': { S: 'pending' } },
    },
  };
}

/**
 * Drop the token's lookup row.
 *
 * Unconditional: the row is gone either way, and a condition on its existence
 * would turn a retry of a half-observed transaction into a failed accept.
 */
export function invitationTokenDeleteItem(record: InvitationRecord): TransactWriteItem {
  return {
    Delete: {
      TableName: Resource.OrgTable.name,
      Key: {
        pk: { S: OrgKeys.inviteTokenPk(record.tokenHash) },
        sk: { S: OrgKeys.inviteTokenSk() },
      },
    },
  };
}

/** Both writes that retire an invitation: the status, and its token. */
export function retireInvitationItems(
  record: InvitationRecord,
  status: Exclude<InvitationStatus, 'pending'>,
): TransactWriteItem[] {
  return [invitationStatusItem(record, status), invitationTokenDeleteItem(record)];
}

/** Items one revocation costs inside a transaction: the status and the token. */
const ITEMS_PER_REVOCATION = 2;

/**
 * Split a sweep of revocations into the ones that fit beside a mutation and the
 * ones that have to follow it.
 *
 * A demotion or a removal revokes that member's pending invitations, and the
 * whole point of doing it in the same transaction is that the two cannot
 * disagree. DynamoDB caps a transaction at 100 items, though, and the audit
 * event takes one of them — so this says how many fit rather than letting
 * `commitAudited`'s assertion fail a legitimate removal.
 *
 * With the pending cap where it is, `later` is always empty: a member cannot
 * have enough invitations outstanding to overflow. It exists so that raising the
 * cap changes a number rather than breaking removal.
 */
export function planRevocations(
  invitations: InvitationRecord[],
  reservedItems: number,
): { now: InvitationRecord[]; later: InvitationRecord[] } {
  const room = Math.max(
    0,
    Math.floor((TRANSACT_WRITE_ITEM_LIMIT - reservedItems - 1) / ITEMS_PER_REVOCATION),
  );
  return { now: invitations.slice(0, room), later: invitations.slice(room) };
}

/**
 * Revoke what did not fit, after the mutation landed.
 *
 * Its own transactions, without audit events: the mutation's event already
 * records how many invitations the change revoked, and an event per invitation
 * would need the room this path exists because we ran out of. A failure here
 * leaves a pending invitation whose issuer has lost the authority to have made
 * it, which the accept path's `ConditionCheck` refuses anyway — so it is logged
 * and counted rather than raised into a mutation that has already succeeded.
 */
export async function revokeDeferred(invitations: InvitationRecord[]): Promise<void> {
  for (let index = 0; index < invitations.length; index += REVOCATIONS_PER_TRANSACTION) {
    const batch = invitations.slice(index, index + REVOCATIONS_PER_TRANSACTION);
    try {
      await getDynamoClient().send(
        new TransactWriteItemsCommand({
          TransactItems: batch.flatMap((record) => retireInvitationItems(record, 'revoked')),
        }),
      );
    } catch (err) {
      console.error('[invitations] Deferred revocation failed — invitations left pending', {
        inviteIds: batch.map((record) => record.inviteId),
        error: err,
      });
    }
  }
}

const REVOCATIONS_PER_TRANSACTION = Math.floor(TRANSACT_WRITE_ITEM_LIMIT / ITEMS_PER_REVOCATION);

/**
 * Record that the invitation's email did not go out.
 *
 * After the fact and best-effort: the row is committed before the send, the
 * response already reports `emailSent: false`, and failing the request over a
 * flag would fail a request whose work landed. What the flag buys is the pending
 * list — an operator looking at a row nobody accepted can tell "we never
 * delivered this" from "they have not clicked it", and re-inviting the same
 * address replaces the row either way.
 *
 * Conditioned on the row existing so a revoke that raced the send does not
 * resurrect one attribute of a row somebody just retired.
 */
export async function markInvitationSendFailed(record: InvitationRecord): Promise<void> {
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.OrgTable.name,
        Key: {
          pk: { S: OrgKeys.orgPk(record.orgId) },
          sk: { S: OrgKeys.inviteSk(record.inviteId) },
        },
        UpdateExpression: 'SET lastSendFailed = :true',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':true': { BOOL: true } },
      }),
    );
  } catch (err) {
    console.error('[invitations] Could not stamp the failed send on the invitation', {
      orgId: record.orgId,
      inviteId: record.inviteId,
      error: err,
    });
  }
}
