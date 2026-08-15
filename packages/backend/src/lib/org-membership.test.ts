import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    OrgTable: { name: 'OrgTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  OrgKeys,
  listMemberships,
  membershipPermissions,
  resolveMembership,
} from './org-membership.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const JOINED_AT = '2026-01-01T00:00:00.000Z';

describe('OrgKeys', () => {
  it('builds the four row shapes and the reserved SSO lookup', () => {
    expect(OrgKeys.orgPk(ORG_ID)).toBe(`ORG#${ORG_ID}`);
    expect(OrgKeys.memberSk(USER_ID)).toBe(`MEMBER#${USER_ID}`);
    expect(OrgKeys.userPk(USER_ID)).toBe(`USER#${USER_ID}`);
    expect(OrgKeys.membershipSk(ORG_ID)).toBe(`MEMBERSHIP#${ORG_ID}`);
    expect(OrgKeys.inviteSk('invite-1')).toBe('INVITE#invite-1');
    expect(OrgKeys.inviteTokenPk('deadbeef')).toBe('INVITETOKEN#deadbeef');
    expect(OrgKeys.inviteTokenSk()).toBe('LOOKUP');
    expect(OrgKeys.auth0OrgPk('org_abc')).toBe('AUTH0ORG#org_abc');
    expect(OrgKeys.auth0OrgSk()).toBe('LOOKUP');
  });

  it('parses an org id back out of the inverse item sort key', () => {
    expect(OrgKeys.parseMembershipSk(OrgKeys.membershipSk(ORG_ID))).toBe(ORG_ID);
  });

  it.each([['MEMBER#abc'], ['MEMBERSHIP#'], ['MEMBERSHIP#has#hash'], ['']])(
    'returns undefined for %s',
    (sk) => {
      expect(OrgKeys.parseMembershipSk(sk)).toBeUndefined();
    },
  );
});

describe('resolveMembership', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('reads the membership row from OrgTable', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        role: { S: OrgRole.Member },
        joinedAt: { S: JOINED_AT },
        source: { S: 'invitation' },
        invitedBy: { S: 'inviter' },
      },
    });

    const membership = await resolveMembership(ORG_ID, USER_ID);

    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input).toMatchObject({
      TableName: 'OrgTable',
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `MEMBER#${USER_ID}` } },
    });
    expect(membership).toStrictEqual({
      orgId: ORG_ID,
      userId: USER_ID,
      role: OrgRole.Member,
      joinedAt: JOINED_AT,
      source: 'invitation',
      invitedBy: 'inviter',
    });
    expect(membershipPermissions(membership)).toContain('objects.write');
    expect(membershipPermissions(membership)).not.toContain('buckets.delete');
  });

  it('resolves an absent row as Owner until the conversion backfills it', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const membership = await resolveMembership(ORG_ID, USER_ID);

    expect(membership).toStrictEqual({ orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner });
    expect(membershipPermissions(membership)).toContain('org.delete');
  });

  it('grants nothing for a row carrying an unrecognized role', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).resolves({ Item: { role: { S: 'billing' } } });

    const membership = await resolveMembership(ORG_ID, USER_ID);

    expect(membershipPermissions(membership)).toStrictEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('listMemberships', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('queries the inverse items and returns one row per org', async () => {
    const otherOrgId = '99999999-8888-7777-6666-555555555555';
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          sk: { S: `MEMBERSHIP#${ORG_ID}` },
          role: { S: OrgRole.Owner },
          joinedAt: { S: JOINED_AT },
        },
        {
          sk: { S: `MEMBERSHIP#${otherOrgId}` },
          role: { S: OrgRole.Admin },
          joinedAt: { S: JOINED_AT },
        },
      ],
    });

    const memberships = await listMemberships(USER_ID);

    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${USER_ID}` },
        ':skPrefix': { S: 'MEMBERSHIP#' },
      },
    });
    expect(memberships).toStrictEqual([
      { orgId: ORG_ID, role: OrgRole.Owner, joinedAt: JOINED_AT },
      { orgId: otherOrgId, role: OrgRole.Admin, joinedAt: JOINED_AT },
    ]);
  });

  it('skips rows whose sort key is not a well-formed membership key', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ sk: { S: 'MEMBERSHIP#' }, role: { S: OrgRole.Owner } }],
    });

    expect(await listMemberships(USER_ID)).toStrictEqual([]);
  });

  it('returns an empty list when the user has no memberships', async () => {
    ddbMock.on(QueryCommand).resolves({});

    expect(await listMemberships(USER_ID)).toStrictEqual([]);
  });
});
