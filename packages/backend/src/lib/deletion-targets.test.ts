import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    OrgTable: { name: 'OrgTable' },
  },
}));

const mockGetProvisionedRegions = vi.fn(async () => [] as unknown[]);
vi.mock('./region-helpers.js', () => ({
  getProvisionedRegions: (...args: unknown[]) => mockGetProvisionedRegions(...(args as [])),
}));

const ddbMock = mockClient(DynamoDBClient);

import { resolveDeletionTargets } from './deletion-targets.js';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

function memberRow(userId: string, extra: Record<string, unknown> = {}) {
  return marshall({ pk: `ORG#${ORG}`, sk: `MEMBER#${userId}`, ...extra });
}

function inverseItem(userId: string, orgId: string, joinedAt = '') {
  return marshall({ pk: `USER#${userId}`, sk: `MEMBERSHIP#${orgId}`, role: 'owner', joinedAt });
}

/**
 * Both member enumerations and the membership walk are Queries on three
 * different partitions, so each is stubbed by the key it reads.
 */
function stubMembers(options: {
  orgTable?: Record<string, unknown>[];
  userInfo?: Record<string, unknown>[];
  memberships?: Record<string, Record<string, unknown>[]>;
}) {
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk: string = input.ExpressionAttributeValues[':pk']?.S ?? '';
    if (input.TableName === 'UserInfoTable') return { Items: options.userInfo ?? [] };
    if (pk.startsWith('USER#')) {
      const userId = pk.slice('USER#'.length);
      return { Items: options.memberships?.[userId] ?? [] };
    }
    return { Items: options.orgTable ?? [] };
  });
}

function stubProfiles(subs: Record<string, string | undefined>) {
  ddbMock.on(GetItemCommand).callsFake((input) => {
    const pk: string = input.Key.pk?.S ?? '';
    if (input.TableName === 'BillingTable') return { Item: undefined };
    const sub = subs[pk.slice('USER#'.length)];
    return { Item: sub ? marshall({ sub }) : undefined };
  });
}

describe('resolveDeletionTargets', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockGetProvisionedRegions.mockResolvedValue([]);
    stubMembers({});
    stubProfiles({ 'user-1': 'auth0|one', 'user-2': 'auth0|two' });
  });

  it('enumerates members from OrgTable', async () => {
    stubMembers({
      orgTable: [memberRow('user-1', { source: 'conversion' })],
      memberships: { 'user-1': [inverseItem('user-1', ORG)] },
    });

    const { members } = await resolveDeletionTargets(ORG);

    expect(members).toEqual([{ userId: 'user-1', sub: 'auth0|one', deleteIdentity: true }]);
  });

  // The conversion runs org by org: until it reaches an org, the only membership
  // row it has is the legacy one, and resolving no members marks teardown done.
  it('enumerates an unconverted org from its legacy UserInfoTable rows', async () => {
    stubMembers({ userInfo: [memberRow('user-1')] });

    const { members } = await resolveDeletionTargets(ORG);

    expect(members).toEqual([{ userId: 'user-1', sub: 'auth0|one', deleteIdentity: true }]);
  });

  it('unions the two tables, counting a member in both only once', async () => {
    stubMembers({
      orgTable: [memberRow('user-1', { source: 'conversion' })],
      userInfo: [memberRow('user-1'), memberRow('user-2')],
    });

    const { members } = await resolveDeletionTargets(ORG);

    expect(members.map((m) => m.userId)).toEqual(['user-1', 'user-2']);
  });

  it('reads both member enumerations consistently', async () => {
    stubMembers({ orgTable: [memberRow('user-1')] });

    await resolveDeletionTargets(ORG);

    for (const call of ddbMock.commandCalls(QueryCommand)) {
      expect(call.args[0].input.ConsistentRead).toBe(true);
    }
    for (const call of ddbMock.commandCalls(GetItemCommand)) {
      expect(call.args[0].input.ConsistentRead).toBe(true);
    }
  });

  it('drops a member with no sub rather than wedging the pass', async () => {
    stubMembers({ orgTable: [memberRow('user-1'), memberRow('user-9')] });
    stubProfiles({ 'user-1': 'auth0|one' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { members } = await resolveDeletionTargets(ORG);
      expect(members.map((m) => m.userId)).toEqual(['user-1']);
    } finally {
      error.mockRestore();
    }
  });

  it('carries the member Stripe customer id when there is one', async () => {
    stubMembers({ orgTable: [memberRow('user-1')] });
    ddbMock.on(GetItemCommand).callsFake((input) => {
      if (input.TableName === 'BillingTable') {
        return { Item: marshall({ stripeCustomerId: 'cus_1' }) };
      }
      return { Item: marshall({ sub: 'auth0|one' }) };
    });

    const { members } = await resolveDeletionTargets(ORG);

    expect(members[0]!.stripeCustomerId).toBe('cus_1');
  });

  // `sub` is a DynamoDB reserved word, so the profile read must alias it or
  // DynamoDB rejects the whole ProjectionExpression and every teardown fails.
  it('aliases the reserved word `sub` in the profile projection', async () => {
    stubMembers({ orgTable: [memberRow('user-1')] });

    await resolveDeletionTargets(ORG);

    const profileRead = ddbMock
      .commandCalls(GetItemCommand)
      .find((call) => call.args[0].input.TableName === 'UserInfoTable')!.args[0].input;
    expect(profileRead).toMatchObject({
      ProjectionExpression: '#sub',
      ExpressionAttributeNames: { '#sub': 'sub' },
      ConsistentRead: true,
    });
  });

  // The tenant ids teardown deletes come from the provisioned regions, keyed by
  // orchestrator. A stale read here would orphan a live tenant permanently, so the
  // lookup is consistent.
  it('maps every provisioned region to its tenant id', async () => {
    stubMembers({ orgTable: [memberRow('user-1')] });
    mockGetProvisionedRegions.mockResolvedValue([
      { orchestrator: { id: 'fth' }, tenantId: '42' },
      { orchestrator: { id: 'ord' }, tenantId: '43' },
    ]);

    const { tenantIds } = await resolveDeletionTargets(ORG);

    expect(tenantIds).toEqual({ fth: '42', ord: '43' });
    expect(mockGetProvisionedRegions).toHaveBeenCalledWith(ORG, { consistent: true });
  });

  describe('the sole-membership census', () => {
    it('tears down the account of a sole member of their own org', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: { 'user-1': [inverseItem('user-1', ORG)] },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.deleteIdentity).toBe(true);
    });

    it('keeps the account of a member who belongs to another org', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: {
          'user-1': [inverseItem('user-1', ORG), inverseItem('user-1', OTHER_ORG)],
        },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.deleteIdentity).toBe(false);
    });

    // The org was never this member's to lose: they were invited into it.
    it('keeps the account of an invited sole member', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'invitation' })],
        memberships: { 'user-1': [inverseItem('user-1', ORG)] },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.deleteIdentity).toBe(false);
    });

    it('decides per member', async () => {
      stubMembers({
        orgTable: [
          memberRow('user-1', { source: 'signup' }),
          memberRow('user-2', { source: 'invitation' }),
        ],
        memberships: {
          'user-1': [inverseItem('user-1', ORG)],
          'user-2': [inverseItem('user-2', ORG)],
        },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members.map((m) => m.deleteIdentity)).toEqual([true, false]);
    });

    // A member the conversion has not reached has no inverse item and no source,
    // and tears down exactly as they did before multi-org membership existed.
    it('tears down a legacy member with no recorded source', async () => {
      stubMembers({ userInfo: [memberRow('user-1')] });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.deleteIdentity).toBe(true);
    });

    // listMemberships drops a row it cannot decode, and a dropped row is exactly
    // what makes a member of two orgs read as a member of one.
    it('keeps the account of a member whose membership row will not decode', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: {
          'user-1': [
            inverseItem('user-1', ORG),
            marshall({ pk: 'USER#user-1', sk: 'MEMBERSHIP#', role: 'owner', joinedAt: '' }),
          ],
        },
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { members } = await resolveDeletionTargets(ORG);
        expect(members[0]!.deleteIdentity).toBe(false);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('undecodable membership rows'),
          expect.objectContaining({ userId: 'user-1', undecodable: 1 }),
        );
      } finally {
        error.mockRestore();
      }
    });

    it('keeps the account of a member whose membership row carries an unknown role', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: {
          'user-1': [
            inverseItem('user-1', ORG),
            marshall({ pk: 'USER#user-1', sk: `MEMBERSHIP#${OTHER_ORG}`, role: 'wizard' }),
          ],
        },
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { members } = await resolveDeletionTargets(ORG);
        expect(members[0]!.deleteIdentity).toBe(false);
      } finally {
        error.mockRestore();
      }
    });

    it('logs the census for every member', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'invitation' })],
        memberships: {
          'user-1': [inverseItem('user-1', ORG), inverseItem('user-1', OTHER_ORG)],
        },
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await resolveDeletionTargets(ORG);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('membership census'), {
          orgId: ORG,
          userId: 'user-1',
          source: 'invitation',
          otherOrgIds: [OTHER_ORG],
          deleteIdentity: false,
          keptReasons: ['OTHER_MEMBERSHIPS', 'INVITED_MEMBER'],
        });
      } finally {
        log.mockRestore();
      }
    });

    // Three conditions reach the same kept account and the teardown has to tell
    // them apart: one is an ordinary multi-org member, one was only ever invited
    // here, and one is a census that could not read a row and failed closed.
    it('carries every reason an account was kept', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'invitation' })],
        memberships: { 'user-1': [inverseItem('user-1', ORG)] },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.keptReasons).toStrictEqual(['INVITED_MEMBER']);
    });

    it('records no reasons for an account that ends with the org', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: { 'user-1': [inverseItem('user-1', ORG)] },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.deleteIdentity).toBe(true);
      expect(members[0]!.keptReasons).toBeUndefined();
    });

    it('names the undecodable census separately from a second membership', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: {
          'user-1': [
            inverseItem('user-1', ORG),
            marshall({ pk: 'USER#user-1', sk: `MEMBERSHIP#${OTHER_ORG}`, role: 'wizard' }),
          ],
        },
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { members } = await resolveDeletionTargets(ORG);
        expect(members[0]!.keptReasons).toStrictEqual(['UNDECODABLE_MEMBERSHIPS']);
      } finally {
        error.mockRestore();
      }
    });
  });

  describe("a surviving member's next org", () => {
    const THIRD_ORG = 'org-3';

    it('is the membership they joined earliest', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: {
          'user-1': [
            inverseItem('user-1', ORG, '2026-01-01T00:00:00.000Z'),
            inverseItem('user-1', THIRD_ORG, '2026-03-01T00:00:00.000Z'),
            inverseItem('user-1', OTHER_ORG, '2026-02-01T00:00:00.000Z'),
          ],
        },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.homeOrgId).toBe(OTHER_ORG);
    });

    it('breaks a tie on the smallest org id', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: {
          'user-1': [
            inverseItem('user-1', THIRD_ORG, '2026-02-01T00:00:00.000Z'),
            inverseItem('user-1', OTHER_ORG, '2026-02-01T00:00:00.000Z'),
          ],
        },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.homeOrgId).toBe(OTHER_ORG);
    });

    // Their rows go with the account, so there is nothing to re-point.
    it('is unset for a member whose account this deletion ends', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'signup' })],
        memberships: { 'user-1': [inverseItem('user-1', ORG)] },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!.homeOrgId).toBeUndefined();
    });

    // Invited into the org they are losing, and a member of nothing else.
    it('is unset for a survivor with nowhere to go', async () => {
      stubMembers({
        orgTable: [memberRow('user-1', { source: 'invitation' })],
        memberships: { 'user-1': [inverseItem('user-1', ORG)] },
      });

      const { members } = await resolveDeletionTargets(ORG);

      expect(members[0]!).toMatchObject({ deleteIdentity: false });
      expect(members[0]!.homeOrgId).toBeUndefined();
    });
  });

  it('pages both member enumerations', async () => {
    const cursor = marshall({ pk: `ORG#${ORG}`, sk: 'MEMBER#user-1' });
    let first = true;
    ddbMock.on(QueryCommand).callsFake((input) => {
      const pk: string = input.ExpressionAttributeValues[':pk']?.S ?? '';
      if (pk.startsWith('USER#')) return { Items: [] };
      if (input.TableName === 'OrgTable' && first) {
        first = false;
        return { Items: [memberRow('user-1')], LastEvaluatedKey: cursor };
      }
      return { Items: input.TableName === 'OrgTable' ? [memberRow('user-2')] : [] };
    });

    const { members } = await resolveDeletionTargets(ORG);

    expect(members.map((m) => m.userId)).toEqual(['user-1', 'user-2']);
    const orgQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.TableName === 'OrgTable');
    expect(orgQueries[1]!.args[0].input.ExclusiveStartKey).toEqual(cursor);
  });
});
