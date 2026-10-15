import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Region } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
import { FakeIamOrchestrator } from '../test/fake-iam-orchestrator.ts';
import { fakeOrchestrator, tenantFor } from '../test/fake-orchestrator.ts';

vi.mock('sst', () => sstResourceMock());

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const iam = new FakeIamOrchestrator();
const iamRegion = fakeOrchestrator('forgeDev', { region: S3Region.UsEast9, iam });
const scopedRegion = fakeOrchestrator('aurora', { region: S3Region.EuWest1 });
const TENANT = tenantFor('forgeDev', ORG_ID);

const regions: unknown[] = [];
vi.mock('./service-orchestrator-registry.ts', () => ({
  getAvailableOrchestrators: () => regions,
}));

import { registerMemberPrincipal, removeMemberPrincipal } from './member-principals.ts';

const ANY_USER = '00000000-0000-0000-0000-000000000011';

const ddbMock = mockClient(DynamoDBClient);
const orgProfile = { pk: { S: `ORG#${ORG_ID}` } };
const profileKey = { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ddbMock.reset();
  iam.principals.clear();
  iam.policies.clear();
  iam.calls.length = 0;
  regions.splice(0, regions.length, scopedRegion, iamRegion);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('removeMemberPrincipal', () => {
  it('removes the principal in each ready iam region', async () => {
    iam.seedPrincipal(TENANT, ANY_USER);

    await removeMemberPrincipal({ orgProfile, userId: ANY_USER });

    expect(iam.calls).toStrictEqual([
      { method: 'removeMember', tenantId: TENANT, target: ANY_USER },
    ]);
    expect(iam.principals.get(TENANT)!.has(ANY_USER)).toBe(false);
  });

  it('throws naming the region whose removal failed', async () => {
    iam.failNext('removeMember', new Error('vendor down'));

    await expect(removeMemberPrincipal({ orgProfile, userId: ANY_USER })).rejects.toMatchObject({
      name: 'IamRegionRefusedError',
      action: 'remove',
      regions: [S3Region.UsEast9],
    });
  });

  it('skips a region whose tenant is not provisioned', async () => {
    await removeMemberPrincipal({ orgProfile: undefined, userId: ANY_USER });

    expect(iam.calls).toStrictEqual([]);
  });
});

describe('registerMemberPrincipal', () => {
  it('creates the principal in each ready iam region, from a consistent read of the org profile', async () => {
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable', Key: profileKey, ConsistentRead: true })
      .resolves({ Item: orgProfile });

    await registerMemberPrincipal({ orgId: ORG_ID, userId: ANY_USER });

    expect(iam.calls).toStrictEqual([{ method: 'syncMember', tenantId: TENANT, target: ANY_USER }]);
    expect(iam.principals.get(TENANT)!.has(ANY_USER)).toBe(true);
  });

  it('throws naming the region that refused the member', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: orgProfile });
    iam.failNext('syncMember', new Error('vendor down'));

    await expect(
      registerMemberPrincipal({ orgId: ORG_ID, userId: ANY_USER }),
    ).rejects.toMatchObject({
      name: 'IamRegionRefusedError',
      action: 'register',
      regions: [S3Region.UsEast9],
    });
  });

  it('reads nothing when no region serves the iam access model', async () => {
    regions.splice(0, regions.length, scopedRegion);

    await registerMemberPrincipal({ orgId: ORG_ID, userId: ANY_USER });

    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });
});
