import { describe, it, expect, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

import { OrgKeys } from './org-membership.js';
import {
  cancelledLabels,
  creatorRoleStillMintsCheck,
  inviterAuthorityCheck,
  membershipDeleteItems,
  membershipRows,
  ownerCountDeltaFor,
  ownerCountItem,
  roleChangeItems,
} from './membership-changes.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const JOINED_AT = '2026-08-14T00:00:00.000Z';

describe('membershipRows', () => {
  it('writes the canonical row create-only and the inverse item beside it', () => {
    const [canonical, inverse] = membershipRows({
      orgId: ORG_ID,
      userId: USER_ID,
      role: OrgRole.Member,
      origin: { joinedAt: JOINED_AT, source: 'invitation', invitedBy: 'inviter-id' },
    });

    expect(canonical.Put).toMatchObject({
      TableName: 'OrgTable',
      Item: {
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.memberSk(USER_ID) },
        role: { S: OrgRole.Member },
        joinedAt: { S: JOINED_AT },
        source: { S: 'invitation' },
        invitedBy: { S: 'inviter-id' },
      },
      // Two accepts of the same invitation: one lands, the other cancels here
      // rather than overwriting a role somebody already holds.
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(inverse.Put).toMatchObject({
      Item: { pk: { S: OrgKeys.userPk(USER_ID) }, sk: { S: OrgKeys.membershipSk(ORG_ID) } },
    });
    // The inverse item carries no authority, so a stale one is corrected rather
    // than being the reason a member cannot join.
    expect(inverse.Put?.ConditionExpression).toBeUndefined();
  });

  it('omits invitedBy for a member who was not invited', () => {
    const [canonical] = membershipRows({
      orgId: ORG_ID,
      userId: USER_ID,
      role: OrgRole.Owner,
      origin: { joinedAt: JOINED_AT, source: 'signup' },
    });

    expect(canonical.Put?.Item).not.toHaveProperty('invitedBy');
  });
});

describe('roleChangeItems', () => {
  it('conditions the canonical update on the role that was read', () => {
    const [canonical, inverse] = roleChangeItems({
      orgId: ORG_ID,
      userId: USER_ID,
      fromRole: OrgRole.Member,
      toRole: OrgRole.Admin,
    });

    expect(canonical.Update).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk(USER_ID) } },
      UpdateExpression: 'SET #role = :role',
      // Two concurrent conflicting changes: the loser cancels instead of both
      // landing and the log claiming a transition that never happened.
      ConditionExpression: 'attribute_exists(pk) AND #role = :fromRole',
      ExpressionAttributeValues: {
        ':role': { S: OrgRole.Admin },
        ':fromRole': { S: OrgRole.Member },
      },
    });
    expect(inverse.Update).toMatchObject({
      Key: { pk: { S: OrgKeys.userPk(USER_ID) }, sk: { S: OrgKeys.membershipSk(ORG_ID) } },
      ExpressionAttributeValues: { ':role': { S: OrgRole.Admin } },
    });
    expect(inverse.Update?.ConditionExpression).toBeUndefined();
  });
});

describe('membershipDeleteItems', () => {
  it('requires the canonical row in the role it was read in, and tolerates a missing inverse item', () => {
    const [canonical, inverse] = membershipDeleteItems({
      orgId: ORG_ID,
      userId: USER_ID,
      fromRole: OrgRole.Owner,
    });

    // The role, because the transaction's owner-count delta was decided from it:
    // a promotion landing in the gap would otherwise delete an Owner with no
    // decrement, and the counter that overcounts is the one the last-Owner guard
    // reads.
    expect(canonical.Delete).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk(USER_ID) } },
      ConditionExpression: 'attribute_exists(pk) AND #role = :fromRole',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':fromRole': { S: OrgRole.Owner } },
    });
    expect(inverse.Delete?.ConditionExpression).toBeUndefined();
  });
});

describe('ownerCountItem', () => {
  it('guards the decrement with the same operation that applies it', () => {
    // DynamoDB permits one operation per item per transaction, so the last-Owner
    // check cannot be a separate ConditionCheck on the META row.
    expect(ownerCountItem(ORG_ID, 'decrement').Update).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: 'META' } },
      UpdateExpression: 'SET ownerCount = ownerCount - :one ADD ownerSetRev :one',
      ConditionExpression: 'ownerCount > :one',
      ExpressionAttributeValues: { ':one': { N: '1' } },
    });
  });

  it('increments only when the counter exists', () => {
    expect(ownerCountItem(ORG_ID, 'increment').Update).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount + :one ADD ownerSetRev :one',
      // An org with no META row is a conversion gap; inventing a counter would
      // silently set the invariant to whatever one transaction happened to know.
      ConditionExpression: 'attribute_exists(ownerCount)',
    });
  });

  it('still writes the counter when the owner set only swaps members', () => {
    // Ownership transfer promotes and demotes in one transaction; touching the
    // META row is what puts it in that transaction, so a concurrent promotion
    // cannot interleave.
    expect(ownerCountItem(ORG_ID, 'unchanged').Update).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount + :zero ADD ownerSetRev :one',
      ConditionExpression: 'attribute_exists(ownerCount)',
      ExpressionAttributeValues: { ':zero': { N: '0' } },
    });
  });

  it.each([
    [OrgRole.Admin, OrgRole.Owner, 'increment'],
    [OrgRole.Owner, OrgRole.Admin, 'decrement'],
    [OrgRole.Owner, OrgRole.ReadOnly, 'decrement'],
    [OrgRole.Member, OrgRole.Admin, 'unchanged'],
    [OrgRole.Owner, OrgRole.Owner, 'unchanged'],
  ])('moves the counter %s → %s by %s', (fromRole, toRole, expected) => {
    expect(ownerCountDeltaFor(fromRole, toRole)).toBe(expected);
  });
});

describe('inviterAuthorityCheck', () => {
  it('admits only Owners for an Owner invitation', () => {
    const check = inviterAuthorityCheck({
      orgId: ORG_ID,
      invitedBy: 'inviter-id',
      invitedRole: OrgRole.Owner,
    });

    expect(check.ConditionCheck).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk('inviter-id') } },
      ConditionExpression: 'attribute_exists(pk) AND #role IN (:role0)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role0': { S: OrgRole.Owner } },
    });
  });

  it.each([OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly])(
    'admits Owners and Admins for an %s invitation',
    (invitedRole) => {
      const check = inviterAuthorityCheck({ orgId: ORG_ID, invitedBy: 'inviter-id', invitedRole });

      expect(check.ConditionCheck?.ConditionExpression).toBe(
        'attribute_exists(pk) AND #role IN (:role0, :role1)',
      );
      expect(check.ConditionCheck?.ExpressionAttributeValues).toStrictEqual({
        ':role0': { S: OrgRole.Owner },
        ':role1': { S: OrgRole.Admin },
      });
    },
  );
});

describe('creatorRoleStillMintsCheck', () => {
  it('admits only Owners when the cap ran against an Owner', () => {
    const check = creatorRoleStillMintsCheck({
      orgId: ORG_ID,
      userId: 'creator-id',
      role: OrgRole.Owner,
    });

    expect(check.ConditionCheck).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk('creator-id') } },
      ConditionExpression: 'attribute_exists(pk) AND #role IN (:role0)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role0': { S: OrgRole.Owner } },
    });
  });

  it('admits a promotion and refuses a demotion when the cap ran against a Member', () => {
    const check = creatorRoleStillMintsCheck({
      orgId: ORG_ID,
      userId: 'creator-id',
      role: OrgRole.Member,
    });

    expect(check.ConditionCheck?.ConditionExpression).toBe(
      'attribute_exists(pk) AND #role IN (:role0, :role1, :role2)',
    );
    expect(check.ConditionCheck?.ExpressionAttributeValues).toStrictEqual({
      ':role0': { S: OrgRole.Owner },
      ':role1': { S: OrgRole.Admin },
      ':role2': { S: OrgRole.Member },
    });
  });

  it('admits every role when the cap ran against ReadOnly, which nothing narrows', () => {
    const check = creatorRoleStillMintsCheck({
      orgId: ORG_ID,
      userId: 'creator-id',
      role: OrgRole.ReadOnly,
    });

    expect(check.ConditionCheck?.ConditionExpression).toBe(
      'attribute_exists(pk) AND #role IN (:role0, :role1, :role2, :role3)',
    );
    expect(check.ConditionCheck?.ExpressionAttributeValues).toStrictEqual({
      ':role0': { S: OrgRole.Owner },
      ':role1': { S: OrgRole.Admin },
      ':role2': { S: OrgRole.Member },
      ':role3': { S: OrgRole.ReadOnly },
    });
  });
});

describe('cancelledLabels', () => {
  function cancelled(codes: (string | undefined)[]) {
    return new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: codes.map((Code) => (Code ? { Code } : { Code: 'None' })),
    });
  }

  it('names the items whose conditions failed', () => {
    const err = cancelled([undefined, 'ConditionalCheckFailed', undefined]);

    expect(cancelledLabels(err, ['membership', 'invitation', 'audit'])).toStrictEqual([
      'invitation',
    ]);
  });

  it('names several when several failed', () => {
    const err = cancelled(['ConditionalCheckFailed', undefined, 'ConditionalCheckFailed']);

    expect(cancelledLabels(err, ['membership', 'invitation', 'ownerCount'])).toStrictEqual([
      'membership',
      'ownerCount',
    ]);
  });

  it('returns nothing for an error that is not a cancellation', () => {
    expect(cancelledLabels(new Error('throttled'), ['membership'])).toStrictEqual([]);
  });

  it('falls back to a positional name rather than losing a reason', () => {
    const err = cancelled([undefined, 'ConditionalCheckFailed']);

    expect(cancelledLabels(err, ['membership'])).toStrictEqual(['item1']);
  });

  it.each([
    ['TransactionConflict'],
    ['ThrottlingError'],
    ['ProvisionedThroughputExceeded'],
    ['ValidationError'],
  ])('does not read %s as a condition that failed', (code) => {
    // Every caller turns a named item into a statement about the world — this
    // org has one Owner, this person is not a member, somebody accepted first —
    // and those are true only of a guard that fired. A conflict means the
    // opposite: the write did not happen, try again. So the list stays empty and
    // the caller's throw stands, which becomes a retryable error rather than a
    // verdict.
    const err = cancelled([code, undefined]);

    expect(cancelledLabels(err, ['ownerCount', 'membership'])).toStrictEqual([]);
  });

  it('names only the items whose conditions failed, beside a conflict', () => {
    const err = cancelled(['TransactionConflict', 'ConditionalCheckFailed']);

    expect(cancelledLabels(err, ['ownerCount', 'invitation'])).toStrictEqual(['invitation']);
  });
});
