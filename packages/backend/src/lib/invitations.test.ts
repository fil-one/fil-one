import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole, INVITE_EXPIRY_DAYS } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { OrgKeys } from './org-membership.js';
import {
  hashInviteToken,
  invitationRows,
  invitationSummary,
  inviteExpiresAt,
  isInvitationExpired,
  isInvitationUsable,
  listInvitations,
  listUsableInvitations,
  newInviteToken,
  normalizeInviteEmail,
  pendingInvitationsFrom,
  readInvitation,
  resolveInvitationByToken,
  retireInvitationItems,
} from './invitations.js';
import type { InvitationRecord } from './invitations.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ORG_ID = '99999999-8888-7777-6666-555555555555';
const INVITE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INVITER = 'inviter-user-id';
const NOW = new Date('2026-08-14T12:00:00.000Z');

function record(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  const createdAt = '2026-08-14T00:00:00.000Z';
  return {
    orgId: ORG_ID,
    inviteId: INVITE_ID,
    email: 'Invitee@Example.com',
    emailNorm: 'invitee@example.com',
    role: OrgRole.Member,
    invitedBy: INVITER,
    status: 'pending',
    createdAt,
    expiresAt: inviteExpiresAt(createdAt),
    tokenHash: 'a'.repeat(64),
    ...overrides,
  };
}

/** The stored row for a record, as DynamoDB hands it back. */
function storedItem(from: InvitationRecord): Record<string, { S: string }> {
  return {
    pk: { S: OrgKeys.orgPk(from.orgId) },
    sk: { S: OrgKeys.inviteSk(from.inviteId) },
    email: { S: from.email },
    emailNorm: { S: from.emailNorm },
    role: { S: from.role },
    invitedBy: { S: from.invitedBy },
    status: { S: from.status },
    createdAt: { S: from.createdAt },
    expiresAt: { S: from.expiresAt },
    tokenHash: { S: from.tokenHash },
  };
}

function stubInvitationRead(from: InvitationRecord) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(from.orgId) }, sk: { S: OrgKeys.inviteSk(from.inviteId) } },
    })
    .resolves({ Item: storedItem(from) });
}

function stubTokenLookup(tokenHash: string, target?: { orgId: string; inviteId: string }) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: {
        pk: { S: OrgKeys.inviteTokenPk(tokenHash) },
        sk: { S: OrgKeys.inviteTokenSk() },
      },
    })
    .resolves(
      target ? { Item: { orgId: { S: target.orgId }, inviteId: { S: target.inviteId } } } : {},
    );
}

describe('invitation tokens', () => {
  it('mints a token nothing can guess and stores only its digest', () => {
    const token = newInviteToken();
    const other = newInviteToken();

    expect(token).not.toBe(other);
    // 32 random bytes, base64url — no padding, url-safe alphabet only.
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(hashInviteToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(token)).not.toContain(token);
  });

  it('hashes the same token to the same digest, since the digest is the address', () => {
    const token = newInviteToken();

    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
  });
});

describe('normalizeInviteEmail', () => {
  it.each([
    ['Invitee@Example.com', 'invitee@example.com'],
    ['  invitee@example.com  ', 'invitee@example.com'],
    ['INVITEE@EXAMPLE.COM', 'invitee@example.com'],
  ])('lowercases and trims %s', (input, expected) => {
    expect(normalizeInviteEmail(input)).toBe(expected);
  });

  it.each([
    ['a plus tag', 'invitee+work@gmail.com'],
    ['dots in the local part', 'in.vi.tee@gmail.com'],
  ])('keeps %s, unlike the entitlement key', (_label, input) => {
    // normalizeEmailForEntitlement collapses these deliberately, to make one
    // trial claim per human. An invitation asks a different question — did THIS
    // verified address receive it — so collapsing would admit an address the
    // invitation was never sent to.
    expect(normalizeInviteEmail(input)).toBe(input);
  });
});

describe('expiry', () => {
  it('expires an invitation 14 days after it was issued', () => {
    const createdAt = '2026-08-14T00:00:00.000Z';

    expect(inviteExpiresAt(createdAt)).toBe('2026-08-28T00:00:00.000Z');
    expect(INVITE_EXPIRY_DAYS).toBe(14);
  });

  it('is usable up to the expiry and not after it', () => {
    const invitation = record();

    expect(isInvitationUsable(invitation, new Date('2026-08-27T23:59:59.000Z'))).toBe(true);
    expect(isInvitationUsable(invitation, new Date('2026-08-28T00:00:01.000Z'))).toBe(false);
    expect(isInvitationExpired(invitation, new Date('2026-08-28T00:00:01.000Z'))).toBe(true);
  });

  it('treats an unparseable expiry as expired', () => {
    // The only way one gets stored is a bad write, and "we do not know when this
    // stops being valid" must not read as "never".
    expect(isInvitationExpired(record({ expiresAt: 'whenever' }), NOW)).toBe(true);
  });

  it.each(['accepted', 'revoked'] as const)('is unusable once %s', (status) => {
    expect(isInvitationUsable(record({ status }), NOW)).toBe(false);
  });

  it('computes expired for the console rather than leaving it date arithmetic', () => {
    expect(invitationSummary(record(), NOW).expired).toBe(false);
    expect(invitationSummary(record(), new Date('2026-09-01T00:00:00.000Z')).expired).toBe(true);
  });

  it('keeps the token out of the wire shape', () => {
    expect(Object.keys(invitationSummary(record(), NOW))).not.toContain('tokenHash');
  });
});

describe('invitationRows', () => {
  it('writes the canonical row and its token lookup, both create-only', () => {
    const invitation = record();

    const [canonical, lookup] = invitationRows(invitation);

    expect(canonical.Put).toMatchObject({
      TableName: 'OrgTable',
      Item: {
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.inviteSk(INVITE_ID) },
        email: { S: 'Invitee@Example.com' },
        emailNorm: { S: 'invitee@example.com' },
        role: { S: OrgRole.Member },
        status: { S: 'pending' },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(lookup.Put).toMatchObject({
      Item: {
        pk: { S: OrgKeys.inviteTokenPk(invitation.tokenHash) },
        sk: { S: 'LOOKUP' },
        orgId: { S: ORG_ID },
        inviteId: { S: INVITE_ID },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });
});

describe('retireInvitationItems', () => {
  it.each(['accepted', 'revoked'] as const)(
    'moves a pending invitation to %s and drops its token',
    (status) => {
      const [update, remove] = retireInvitationItems(record(), status);

      expect(update.Update).toMatchObject({
        Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.inviteSk(INVITE_ID) } },
        UpdateExpression: 'SET #status = :status',
        // The whole race resolution: a revoke and an accept both condition on
        // pending, so one of them cancels cleanly instead of both landing.
        ConditionExpression: '#status = :pending',
        ExpressionAttributeValues: { ':status': { S: status }, ':pending': { S: 'pending' } },
      });
      expect(remove.Delete).toMatchObject({
        Key: { pk: { S: OrgKeys.inviteTokenPk('a'.repeat(64)) }, sk: { S: 'LOOKUP' } },
      });
      expect(remove.Delete?.ConditionExpression).toBeUndefined();
    },
  );
});

describe('readInvitation', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reads the row consistently', async () => {
    stubInvitationRead(record());

    const found = await readInvitation(ORG_ID, INVITE_ID);

    expect(found).toMatchObject({ orgId: ORG_ID, inviteId: INVITE_ID, status: 'pending' });
    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('returns undefined when there is no row', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    expect(await readInvitation(ORG_ID, INVITE_ID)).toBeUndefined();
  });

  it.each([
    ['a role that is not one of the four', { role: 'billing' }],
    ['a status nothing can act on', { status: 'sent' }],
  ])('drops a row carrying %s', async (_label, broken) => {
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: { ...storedItem(record()), ...marshalledStrings(broken) } });

    expect(await readInvitation(ORG_ID, INVITE_ID)).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

function marshalledStrings(values: Record<string, string>): Record<string, { S: string }> {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { S: value }]));
}

describe('resolveInvitationByToken', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('resolves hash → lookup → canonical row, both reads consistent', async () => {
    const token = newInviteToken();
    const invitation = record({ tokenHash: hashInviteToken(token) });
    stubTokenLookup(invitation.tokenHash, { orgId: ORG_ID, inviteId: INVITE_ID });
    stubInvitationRead(invitation);

    const found = await resolveInvitationByToken(token);

    expect(found).toMatchObject({ orgId: ORG_ID, inviteId: INVITE_ID });
    for (const call of ddbMock.commandCalls(GetItemCommand)) {
      expect(call.args[0].input.ConsistentRead).toBe(true);
    }
  });

  it('returns undefined for a token with no lookup row, without reading further', async () => {
    const token = newInviteToken();
    stubTokenLookup(hashInviteToken(token), undefined);

    expect(await resolveInvitationByToken(token)).toBeUndefined();
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
  });

  it('reports an orphaned lookup row by id, never by hash', async () => {
    const token = newInviteToken();
    const tokenHash = hashInviteToken(token);
    stubTokenLookup(tokenHash, { orgId: ORG_ID, inviteId: INVITE_ID });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'OrgTable',
        Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.inviteSk(INVITE_ID) } },
      })
      .resolves({});

    expect(await resolveInvitationByToken(token)).toBeUndefined();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain(INVITE_ID);
    expect(logged).not.toContain(tokenHash);
    expect(logged).not.toContain(token);
  });
});

describe('listInvitations', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function stubQuery(pages: Record<string, { S: string }>[][]) {
    let call = 0;
    ddbMock.on(QueryCommand).callsFake(() => {
      const items = pages[call];
      const isLast = call === pages.length - 1;
      call += 1;
      return {
        Items: items,
        ...(isLast ? {} : { LastEvaluatedKey: { pk: { S: 'more' }, sk: { S: 'more' } } }),
      };
    });
  }

  it('queries the org partition by the invitation prefix', async () => {
    stubQuery([[storedItem(record())]]);

    const found = await listInvitations(ORG_ID);

    expect(found).toHaveLength(1);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'OrgTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'INVITE#' },
      },
      ConsistentRead: true,
    });
  });

  it('follows pagination, because a Query returns at most 1 MB', async () => {
    stubQuery([
      [storedItem(record({ inviteId: 'invite-1' }))],
      [storedItem(record({ inviteId: 'invite-2' }))],
    ]);

    const found = await listInvitations(ORG_ID);

    expect(found.map((invitation) => invitation.inviteId)).toStrictEqual(['invite-1', 'invite-2']);
  });

  it('keeps only what a token could still redeem when asked for the usable ones', async () => {
    stubQuery([
      [
        storedItem(record({ inviteId: 'pending' })),
        storedItem(record({ inviteId: 'revoked', status: 'revoked' })),
        storedItem(record({ inviteId: 'accepted', status: 'accepted' })),
        storedItem(
          record({
            inviteId: 'expired',
            createdAt: '2026-07-01T00:00:00.000Z',
            expiresAt: '2026-07-15T00:00:00.000Z',
          }),
        ),
      ],
    ]);

    const usable = await listUsableInvitations(ORG_ID, NOW);

    expect(usable.map((invitation) => invitation.inviteId)).toStrictEqual(['pending']);
  });

  it('finds the pending invitations one member issued', async () => {
    stubQuery([
      [
        storedItem(record({ inviteId: 'theirs', invitedBy: INVITER })),
        storedItem(record({ inviteId: 'somebody-elses', invitedBy: 'other-user' })),
        storedItem(record({ inviteId: 'already-revoked', invitedBy: INVITER, status: 'revoked' })),
      ],
    ]);

    const theirs = await pendingInvitationsFrom(ORG_ID, INVITER, NOW);

    expect(theirs.map((invitation) => invitation.inviteId)).toStrictEqual(['theirs']);
  });

  it('reads only the org it was asked about', async () => {
    stubQuery([[storedItem(record({ orgId: OTHER_ORG_ID }))]]);

    const found = await listInvitations(ORG_ID);

    // The org id comes from the partition the Query ran in, not from the row.
    expect(found[0].orgId).toBe(ORG_ID);
  });
});
