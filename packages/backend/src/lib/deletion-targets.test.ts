import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
  },
}));

const mockGetProvisionedRegions = vi.fn(async () => [
  { orchestrator: { id: 'fth' }, tenantId: '42' },
]);
vi.mock('./region-helpers.js', () => ({
  getProvisionedRegions: (...args: unknown[]) => mockGetProvisionedRegions(...(args as [])),
}));

const ddbMock = mockClient(DynamoDBClient);

import { resolveDeletionTargets } from './deletion-targets.js';

const ORG = 'org-1';

function memberPage(userIds: string[], lastKey?: string) {
  return {
    Items: userIds.map((userId) => marshall({ pk: `ORG#${ORG}`, sk: `MEMBER#${userId}` })),
    ...(lastKey
      ? { LastEvaluatedKey: marshall({ pk: `ORG#${ORG}`, sk: `MEMBER#${lastKey}` }) }
      : {}),
  };
}

function profile(userId: string) {
  return { TableName: 'UserInfoTable', Key: marshall({ pk: `USER#${userId}`, sk: 'PROFILE' }) };
}

function profileOf(userId: string) {
  return ddbMock
    .commandCalls(GetItemCommand)
    .find((call) => call.args[0].input.Key?.pk?.S === `USER#${userId}`)!.args[0].input;
}

describe('resolveDeletionTargets', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockGetProvisionedRegions.mockResolvedValue([{ orchestrator: { id: 'fth' }, tenantId: '42' }]);
  });

  // The member pages drive a paged Query; `sub` is a DynamoDB reserved word, so the
  // profile read must alias it or DynamoDB rejects the whole ProjectionExpression.
  it('resolves every member across pages and every provisioned tenant', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce(memberPage(['user-1'], 'user-1'))
      .resolves(memberPage(['user-2']));
    ddbMock
      .on(GetItemCommand, profile('user-1'))
      .resolves({ Item: marshall({ sub: 'auth0|one' }) });
    ddbMock
      .on(GetItemCommand, profile('user-2'))
      .resolves({ Item: marshall({ sub: 'auth0|two' }) });
    ddbMock
      .on(GetItemCommand, { TableName: 'BillingTable' })
      .resolves({ Item: marshall({ stripeCustomerId: 'cus_1' }) });

    expect(await resolveDeletionTargets(ORG)).toEqual({
      members: [
        { userId: 'user-1', sub: 'auth0|one', stripeCustomerId: 'cus_1' },
        { userId: 'user-2', sub: 'auth0|two', stripeCustomerId: 'cus_1' },
      ],
      tenantIds: { fth: '42' },
    });

    expect(profileOf('user-1')).toMatchObject({
      ProjectionExpression: '#sub',
      ExpressionAttributeNames: { '#sub': 'sub' },
      ConsistentRead: true,
    });
    expect(mockGetProvisionedRegions).toHaveBeenCalledWith(ORG, { consistent: true });
  });

  // A member with no sub has nothing to delete in Auth0, and must not wedge the pass.
  it('drops a member whose profile has no sub', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(QueryCommand).resolves(memberPage(['user-1', 'user-2']));
    ddbMock.on(GetItemCommand, profile('user-1')).resolves({ Item: marshall({}) });
    ddbMock
      .on(GetItemCommand, profile('user-2'))
      .resolves({ Item: marshall({ sub: 'auth0|two' }) });
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({});

    const { members } = await resolveDeletionTargets(ORG);

    expect(members).toEqual([{ userId: 'user-2', sub: 'auth0|two' }]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
