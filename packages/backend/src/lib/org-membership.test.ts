import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { OrgRole, permissionsForRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { stubMembershipList } from '../test/lambda-test-utilities.js';
import {
  OrgKeys,
  listMembers,
  listMemberships,
  listMembershipRows,
  resolveMembership,
  summarizeMemberships,
} from './org-membership.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ORG_ID = '99999999-8888-7777-6666-555555555555';
const JOINED_AT = '2026-01-01T00:00:00.000Z';

function stubOrgProfile(orgId: string, name: string) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({ Item: { name: { S: name } } });
}

describe('OrgKeys', () => {
  it('builds the row shapes and the reserved SSO lookup', () => {
    expect(OrgKeys.orgPk(ORG_ID)).toBe(`ORG#${ORG_ID}`);
    expect(OrgKeys.memberSk(USER_ID)).toBe(`MEMBER#${USER_ID}`);
    expect(OrgKeys.orgMetaSk()).toBe('META');
    expect(OrgKeys.userPk(USER_ID)).toBe(`USER#${USER_ID}`);
    expect(OrgKeys.membershipSk(ORG_ID)).toBe(`MEMBERSHIP#${ORG_ID}`);
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

  it('parses a member id back out of the canonical sort key', () => {
    expect(OrgKeys.parseMemberSk(OrgKeys.memberSk(USER_ID))).toBe(USER_ID);
  });

  it.each([['MEMBERSHIP#abc'], ['MEMBER#'], ['MEMBER#has#hash'], ['META'], ['']])(
    'rejects %s as a member key',
    (sk) => {
      expect(OrgKeys.parseMemberSk(sk)).toBeUndefined();
    },
  );
});

describe('resolveMembership', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('reads the membership row from OrgTable, consistently', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.memberSk(USER_ID) },
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
      ConsistentRead: true,
    });
    expect(membership).toStrictEqual({
      orgId: ORG_ID,
      userId: USER_ID,
      role: OrgRole.Member,
      joinedAt: JOINED_AT,
      source: 'invitation',
      invitedBy: 'inviter',
    });
    expect(permissionsForRole(membership!.role)).toContain('objects.write');
    expect(permissionsForRole(membership!.role)).not.toContain('buckets.delete');
  });

  it('carries a field the interface does not name yet, without dropping it', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.memberSk(USER_ID) },
        role: { S: OrgRole.Member },
        buckets: { L: [{ S: 'reports' }] },
      },
    });

    const membership = await resolveMembership(ORG_ID, USER_ID);

    expect(membership).toStrictEqual({
      orgId: ORG_ID,
      userId: USER_ID,
      role: OrgRole.Member,
      buckets: ['reports'],
    });
  });

  it('reports an absent row as absent, leaving the default to the middleware', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    expect(await resolveMembership(ORG_ID, USER_ID)).toBeUndefined();
  });

  it('grants nothing for a row carrying an unrecognized role, and logs the value', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).resolves({ Item: { role: { S: 'billing' } } });

    const membership = await resolveMembership(ORG_ID, USER_ID);

    // Kept rather than dropped: undefined would read as the Owner default.
    expect(membership).toBeDefined();
    expect(permissionsForRole(membership!.role)).toStrictEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized role'),
      expect.objectContaining({ orgId: ORG_ID, userId: USER_ID, role: 'billing' }),
    );
    consoleError.mockRestore();
  });
});

describe('listMemberships', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('queries the inverse items and returns one row per org', async () => {
    stubMembershipList(ddbMock, {
      userId: USER_ID,
      orgs: [
        { orgId: ORG_ID, role: OrgRole.Owner, joinedAt: JOINED_AT },
        { orgId: OTHER_ORG_ID, role: OrgRole.Admin, joinedAt: JOINED_AT },
      ],
    });

    const memberships = await listMemberships(USER_ID);

    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${USER_ID}` },
        ':skPrefix': { S: 'MEMBERSHIP#' },
      },
      ConsistentRead: true,
    });
    expect(memberships).toStrictEqual([
      { orgId: ORG_ID, role: OrgRole.Owner, joinedAt: JOINED_AT },
      { orgId: OTHER_ORG_ID, role: OrgRole.Admin, joinedAt: JOINED_AT },
    ]);
  });

  it('drops a row whose sort key is not a well-formed membership key, loudly', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).resolves({
      Items: [{ sk: { S: 'MEMBERSHIP#' }, role: { S: OrgRole.Owner } }],
    });

    expect(await listMemberships(USER_ID)).toStrictEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('membership key'),
      expect.objectContaining({ userId: USER_ID, sk: 'MEMBERSHIP#' }),
    );
    consoleError.mockRestore();
  });

  it('drops a row whose role is not one of the four, naming the value', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: { S: OrgKeys.userPk(USER_ID) },
          sk: { S: OrgKeys.membershipSk(ORG_ID) },
          role: { S: 'billing' },
          joinedAt: { S: JOINED_AT },
        },
        {
          pk: { S: OrgKeys.userPk(USER_ID) },
          sk: { S: OrgKeys.membershipSk(OTHER_ORG_ID) },
          joinedAt: { S: JOINED_AT },
        },
      ],
    });

    expect(await listMemberships(USER_ID)).toStrictEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized role'),
      expect.objectContaining({ orgId: ORG_ID, role: 'billing' }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized role'),
      expect.objectContaining({ orgId: OTHER_ORG_ID, role: '' }),
    );
    consoleError.mockRestore();
  });

  it('follows LastEvaluatedKey until the query is exhausted', async () => {
    const startKey = {
      pk: { S: OrgKeys.userPk(USER_ID) },
      sk: { S: OrgKeys.membershipSk(ORG_ID) },
    };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [
          {
            pk: { S: OrgKeys.userPk(USER_ID) },
            sk: { S: OrgKeys.membershipSk(ORG_ID) },
            role: { S: OrgRole.Owner },
            joinedAt: { S: JOINED_AT },
          },
        ],
        LastEvaluatedKey: startKey,
      })
      .resolves({
        Items: [
          {
            pk: { S: OrgKeys.userPk(USER_ID) },
            sk: { S: OrgKeys.membershipSk(OTHER_ORG_ID) },
            role: { S: OrgRole.Member },
            joinedAt: { S: JOINED_AT },
          },
        ],
      });

    const memberships = await listMemberships(USER_ID);

    expect(memberships.map((membership) => membership.orgId)).toStrictEqual([ORG_ID, OTHER_ORG_ID]);
    expect(ddbMock.commandCalls(QueryCommand)[1].args[0].input).toMatchObject({
      ExclusiveStartKey: startKey,
    });
  });

  it('stops at the cap rather than paging forever, and says so', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = Array.from({ length: 120 }, (_, index) => ({
      pk: { S: OrgKeys.userPk(USER_ID) },
      sk: { S: OrgKeys.membershipSk(`${index}`) },
      role: { S: OrgRole.Member },
      joinedAt: { S: JOINED_AT },
    }));
    ddbMock.on(QueryCommand).resolves({ Items: page, LastEvaluatedKey: { pk: { S: 'more' } } });

    expect(await listMemberships(USER_ID)).toHaveLength(100);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('truncated'),
      expect.objectContaining({ userId: USER_ID, cap: 100 }),
    );
    consoleError.mockRestore();
  });

  it('returns an empty list when the user has no memberships', async () => {
    ddbMock.on(QueryCommand).resolves({});

    expect(await listMemberships(USER_ID)).toStrictEqual([]);
  });
});

// Account deletion ends an account when it reads no other membership, so a row
// dropped on the way out is the difference between a kept login and a deleted
// one. listMembershipRows reports the drops it makes; listMemberships does not.
describe('listMembershipRows', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('counts a row it could not decode', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: { S: OrgKeys.userPk(USER_ID) },
          sk: { S: OrgKeys.membershipSk(ORG_ID) },
          role: { S: OrgRole.Owner },
          joinedAt: { S: JOINED_AT },
        },
        { sk: { S: 'MEMBERSHIP#' }, role: { S: OrgRole.Owner } },
        {
          pk: { S: OrgKeys.userPk(USER_ID) },
          sk: { S: OrgKeys.membershipSk(OTHER_ORG_ID) },
          role: { S: 'wizard' },
        },
      ],
    });

    const listing = await listMembershipRows(USER_ID);

    expect(listing.memberships.map((membership) => membership.orgId)).toStrictEqual([ORG_ID]);
    expect(listing.undecodable).toBe(2);
    consoleError.mockRestore();
  });

  it('counts none when every row decodes', async () => {
    stubMembershipList(ddbMock, {
      userId: USER_ID,
      orgs: [{ orgId: ORG_ID, role: OrgRole.Owner, joinedAt: JOINED_AT }],
    });

    expect(await listMembershipRows(USER_ID)).toStrictEqual({
      memberships: [{ orgId: ORG_ID, role: OrgRole.Owner, joinedAt: JOINED_AT }],
      undecodable: 0,
    });
  });
});

describe('summarizeMemberships', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  const activeOrgSummary = (name: string, slug = 'example-corp') => Promise.resolve({ name, slug });

  it('names every org the user belongs to', async () => {
    stubMembershipList(ddbMock, {
      userId: USER_ID,
      orgs: [
        { orgId: ORG_ID, role: OrgRole.Owner },
        { orgId: OTHER_ORG_ID, role: OrgRole.Member },
      ],
    });
    stubOrgProfile(OTHER_ORG_ID, 'Second Corp');

    const summaries = await summarizeMemberships({
      userId: USER_ID,
      activeOrgId: ORG_ID,
      activeRole: OrgRole.Owner,
      activeOrgSummary: activeOrgSummary('Example Corp'),
    });

    expect(summaries).toStrictEqual([
      {
        orgId: ORG_ID,
        orgName: 'Example Corp',
        slug: 'example-corp',
        role: OrgRole.Owner,
        joinedAt: JOINED_AT,
      },
      {
        orgId: OTHER_ORG_ID,
        orgName: 'Second Corp',
        slug: '',
        role: OrgRole.Member,
        joinedAt: JOINED_AT,
      },
    ]);
    // The active org's name came from the caller's read, not a second one.
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
  });

  it('includes the active org when its inverse item does not exist yet', async () => {
    stubMembershipList(ddbMock, { userId: USER_ID, orgs: [] });

    const summaries = await summarizeMemberships({
      userId: USER_ID,
      activeOrgId: ORG_ID,
      activeRole: OrgRole.Owner,
      activeOrgSummary: activeOrgSummary('Example Corp'),
    });

    expect(summaries).toStrictEqual([
      { orgId: ORG_ID, orgName: 'Example Corp', slug: 'example-corp', role: OrgRole.Owner },
    ]);
  });

  it('reports the active org with the role the request was authorized under', async () => {
    // The inverse item still carries the role a concurrent change has already
    // replaced on the canonical row the middleware read.
    stubMembershipList(ddbMock, {
      userId: USER_ID,
      orgs: [
        { orgId: ORG_ID, role: OrgRole.Owner },
        { orgId: OTHER_ORG_ID, role: OrgRole.Member },
      ],
    });
    stubOrgProfile(OTHER_ORG_ID, 'Second Corp');

    const summaries = await summarizeMemberships({
      userId: USER_ID,
      activeOrgId: ORG_ID,
      activeRole: OrgRole.Member,
      activeOrgSummary: activeOrgSummary('Example Corp'),
    });

    expect(summaries).toStrictEqual([
      {
        orgId: ORG_ID,
        orgName: 'Example Corp',
        slug: 'example-corp',
        role: OrgRole.Member,
        joinedAt: JOINED_AT,
      },
      {
        orgId: OTHER_ORG_ID,
        orgName: 'Second Corp',
        slug: '',
        role: OrgRole.Member,
        joinedAt: JOINED_AT,
      },
    ]);
  });

  it('carries the active org’s logo when it has one', async () => {
    stubMembershipList(ddbMock, { userId: USER_ID, orgs: [] });

    const summaries = await summarizeMemberships({
      userId: USER_ID,
      activeOrgId: ORG_ID,
      activeRole: OrgRole.Owner,
      activeOrgSummary: Promise.resolve({
        name: 'Example Corp',
        slug: 'example-corp',
        logoUrl: 'https://logos.example/example-corp.png',
      }),
    });

    expect(summaries).toStrictEqual([
      {
        orgId: ORG_ID,
        orgName: 'Example Corp',
        slug: 'example-corp',
        role: OrgRole.Owner,
        logoUrl: 'https://logos.example/example-corp.png',
      },
    ]);
  });

  it('leaves an org unnamed when its profile cannot be read', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubMembershipList(ddbMock, {
      userId: USER_ID,
      orgs: [
        { orgId: ORG_ID, role: OrgRole.Owner },
        { orgId: OTHER_ORG_ID, role: OrgRole.Member },
      ],
    });
    ddbMock.on(GetItemCommand).rejects(new Error('DynamoDB unavailable'));

    const summaries = await summarizeMemberships({
      userId: USER_ID,
      activeOrgId: ORG_ID,
      activeRole: OrgRole.Owner,
      activeOrgSummary: activeOrgSummary('Example Corp'),
    });

    expect(summaries).toStrictEqual([
      {
        orgId: ORG_ID,
        orgName: 'Example Corp',
        slug: 'example-corp',
        role: OrgRole.Owner,
        joinedAt: JOINED_AT,
      },
      { orgId: OTHER_ORG_ID, orgName: '', slug: '', role: OrgRole.Member, joinedAt: JOINED_AT },
    ]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('listMembers', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  function memberItem(userId: string, role: string, joinedAt = JOINED_AT) {
    return {
      pk: { S: OrgKeys.orgPk(ORG_ID) },
      sk: { S: OrgKeys.memberSk(userId) },
      role: { S: role },
      joinedAt: { S: joinedAt },
      source: { S: 'invitation' },
    };
  }

  it('walks the org partition by the member prefix, consistently', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [memberItem(USER_ID, OrgRole.Owner)] });

    const members = await listMembers(ORG_ID);

    expect(members).toStrictEqual([
      {
        orgId: ORG_ID,
        userId: USER_ID,
        role: OrgRole.Owner,
        joinedAt: JOINED_AT,
        source: 'invitation',
      },
    ]);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'MEMBER#' },
      },
      ConsistentRead: true,
    });
  });

  it('pages, because a Query returns at most 1 MB', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [memberItem('first-user', OrgRole.Owner)],
        LastEvaluatedKey: { pk: { S: 'more' }, sk: { S: 'more' } },
      })
      .resolves({ Items: [memberItem('second-user', OrgRole.Member)] });

    const members = await listMembers(ORG_ID);

    expect(members.map((member) => member.userId)).toStrictEqual(['first-user', 'second-user']);
  });

  it('drops a row whose role nothing can authorize, and says so', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).resolves({
      Items: [memberItem(USER_ID, OrgRole.Owner), memberItem('broken-user', 'billing')],
    });

    const members = await listMembers(ORG_ID);

    expect(members.map((member) => member.userId)).toStrictEqual([USER_ID]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('drops a row whose sort key is not a well-formed member key, loudly', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).resolves({
      Items: [memberItem(USER_ID, OrgRole.Owner), memberItem('has#hash', OrgRole.Member)],
    });

    const members = await listMembers(ORG_ID);

    expect(members.map((member) => member.userId)).toStrictEqual([USER_ID]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('member key'),
      expect.objectContaining({ orgId: ORG_ID, sk: 'MEMBER#has#hash' }),
    );
    consoleError.mockRestore();
  });

  it('derives the member id from the key rather than the row', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...memberItem(USER_ID, OrgRole.Admin), userId: { S: 'a-lie' } }],
    });

    const [member] = await listMembers(ORG_ID);

    expect(member.userId).toBe(USER_ID);
  });
});
