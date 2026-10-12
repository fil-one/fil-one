import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import {
  OrgRole,
  POLICY_ACTION_WILDCARD,
  ROSTER_ADMIN_ACTIONS,
  ROSTER_ADMINS_SID,
  ROSTER_OWNERS_SID,
  S3Region,
} from '@filone/shared';
import type { BucketPolicy, PolicyStatement } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
import { FakeIamOrchestrator } from '../test/fake-iam-orchestrator.ts';
import { fakeOrchestrator, tenantFor } from '../test/fake-orchestrator.ts';

vi.mock('sst', () => sstResourceMock());

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const ACTOR = { kind: 'user', id: 'admin-1' } as const;

const iam = new FakeIamOrchestrator();
const iamRegion = {
  ...fakeOrchestrator('forgeDev', { region: S3Region.UsEast9, iam }),
  listBuckets: vi.fn(async () => [] as { bucketName: string }[]),
};
const scopedRegion = fakeOrchestrator('aurora', { region: S3Region.EuWest1 });
const TENANT = tenantFor('forgeDev', ORG_ID);

vi.mock('./service-orchestrator-registry.ts', () => ({
  getAvailableOrchestrators: () => [scopedRegion, iamRegion],
}));

const mockListMembers = vi.fn(async (_orgId: string) => [] as { userId: string; role: OrgRole }[]);
vi.mock('./org-membership.ts', () => ({ listMembers: (orgId: string) => mockListMembers(orgId) }));

import { PolicyPreconditionFailedError } from './errors.ts';
import {
  getRosterAfterChange,
  isRosterRole,
  removeMemberPrincipalFromIamRegions,
  syncRosterStatements,
} from './iam-policy-fanout.ts';

const ddbMock = mockClient(DynamoDBClient);
const orgProfile = { pk: { S: `ORG#${ORG_ID}` } };
const roster = { owners: ['owner-1'], admins: ['admin-1'] };
const noRoster = { owners: [], admins: [] };

const rosterStatements: PolicyStatement[] = [
  {
    Sid: ROSTER_OWNERS_SID,
    Effect: 'Allow',
    Principal: ['owner-1'],
    Action: [POLICY_ACTION_WILDCARD],
  },
  { Sid: ROSTER_ADMINS_SID, Effect: 'Allow', Principal: ['admin-1'], Action: ROSTER_ADMIN_ACTIONS },
];

const grantGetObjectToMember: BucketPolicy = {
  Statement: [{ Sid: 'team', Effect: 'Allow', Principal: ['member-1'], Action: ['s3:GetObject'] }],
};

function syncRoster(rosterToWrite = roster) {
  return syncRosterStatements({ orgId: ORG_ID, orgProfile, roster: rosterToWrite, actor: ACTOR });
}

function photosPuts() {
  return iam.calls.filter((c) => c.method === 'putBucketPolicy' && c.target === 'photos');
}

beforeEach(() => {
  vi.clearAllMocks();
  ddbMock.reset();
  ddbMock.on(PutItemCommand).resolves({});
  iam.principals.clear();
  iam.policies.clear();
  iam.buckets.clear();
  iam.calls.length = 0;
  iam.seedPrincipal(TENANT, 'member-1');
  iamRegion.listBuckets.mockResolvedValue([{ bucketName: 'photos' }, { bucketName: 'backups' }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getRosterAfterChange', () => {
  it.each([
    [
      'Admin',
      'admins',
      { userId: 'member-1', role: OrgRole.Admin },
      { owners: ['owner-1'], admins: ['member-1'] },
    ],
    ['Member', 'neither', { userId: 'owner-1', role: OrgRole.Member }, { owners: [], admins: [] }],
  ])('puts a member moving to %s in the %s list', async (_role, _list, target, expected) => {
    mockListMembers.mockResolvedValue([
      { userId: 'owner-1', role: OrgRole.Owner },
      { userId: 'member-1', role: OrgRole.Member },
    ]);

    await expect(getRosterAfterChange(ORG_ID, target)).resolves.toStrictEqual(expected);
  });
});

describe('isRosterRole', () => {
  it.each([
    { role: OrgRole.Owner, expected: true },
    { role: OrgRole.Admin, expected: true },
    { role: OrgRole.Member, expected: false },
    { role: OrgRole.ReadOnly, expected: false },
  ])('returns $expected for $role', ({ role, expected }) => {
    expect(isRosterRole(role), role).toBe(expected);
  });
});

describe('syncRosterStatements', () => {
  it('reports every bucket as updated', async () => {
    iam.seedPolicy(TENANT, 'photos', grantGetObjectToMember);

    await expect(syncRoster()).resolves.toStrictEqual([
      { region: S3Region.UsEast9, bucketsUpdated: 2, bucketsFailed: [], bucketListFailed: false },
    ]);
  });

  it("puts the roster statements ahead of a policy's other statements", async () => {
    iam.seedPolicy(TENANT, 'photos', grantGetObjectToMember);

    await syncRoster();

    expect(iam.policies.get(TENANT)!.get('photos')!.policy).toStrictEqual({
      Statement: [...rosterStatements, ...grantGetObjectToMember.Statement],
    });
  });

  it('creates a roster-only policy on a bucket with none', async () => {
    await syncRoster();

    expect(iam.policies.get(TENANT)!.get('backups')!.policy).toStrictEqual({
      Statement: rosterStatements,
    });
  });

  it('adds each roster member as a principal before writing', async () => {
    await syncRoster();

    expect(iam.calls.map((c) => `${c.method}:${c.target}`)).toStrictEqual([
      'syncMember:owner-1',
      'syncMember:admin-1',
      'getBucketPolicy:photos',
      'putBucketPolicy:photos',
      'getBucketPolicy:backups',
      'putBucketPolicy:backups',
    ]);
  });

  it('skips service-keys regions', async () => {
    const reports = await syncRoster();

    expect(reports.map((report) => report.region)).toStrictEqual([S3Region.UsEast9]);
    expect(scopedRegion.listBuckets).not.toHaveBeenCalled();
  });

  it('does not rewrite a policy that already carries the roster', async () => {
    await syncRoster();
    iam.calls.length = 0;
    ddbMock.resetHistory();

    await syncRoster();

    expect(iam.calls.filter((c) => c.method === 'putBucketPolicy')).toStrictEqual([]);
    expect(ddbMock.commandCalls(PutItemCommand)).toStrictEqual([]);
  });

  it('reports a bucket whose policy read failed', async () => {
    iam.failNext('getBucketPolicy', new Error('vendor down'));

    await expect(syncRoster()).resolves.toStrictEqual([
      {
        region: S3Region.UsEast9,
        bucketsUpdated: 1,
        bucketsFailed: ['photos'],
        bucketListFailed: false,
      },
    ]);
  });

  it('deletes a policy left with no statements', async () => {
    iam.seedPolicy(TENANT, 'photos', { Statement: [rosterStatements[0]!] });

    await syncRoster(noRoster);

    expect([...iam.policies.get(TENANT)!.keys()]).toStrictEqual([]);
  });

  it('retries with a fresh read when the ETag is stale', async () => {
    const firstEtag = iam.seedPolicy(TENANT, 'photos', grantGetObjectToMember);
    const put = iam.putBucketPolicy.bind(iam);
    let secondEtag = '';
    const putSpy = vi.spyOn(iam, 'putBucketPolicy').mockImplementationOnce(async (...args) => {
      // Another writer lands between this sync's read and its write.
      secondEtag = iam.seedPolicy(TENANT, 'photos', grantGetObjectToMember);
      return put(...args);
    });

    const reports = await syncRoster();

    expect(reports).toStrictEqual([
      { region: S3Region.UsEast9, bucketsUpdated: 2, bucketsFailed: [], bucketListFailed: false },
    ]);
    expect(
      putSpy.mock.calls.filter(([, bucketName]) => bucketName === 'photos').map((call) => call[3]),
    ).toStrictEqual([{ ifMatch: firstEtag }, { ifMatch: secondEtag }]);
  });

  it('reports the bucket after the retries run out', async () => {
    const put = iam.putBucketPolicy.bind(iam);
    const putSpy = vi
      .spyOn(iam, 'putBucketPolicy')
      .mockImplementation(async (tenantId, bucketName, ...rest) => {
        if (bucketName === 'photos') throw new PolicyPreconditionFailedError(bucketName);
        return put(tenantId, bucketName, ...rest);
      });

    const reports = await syncRoster();

    expect(reports).toStrictEqual([
      {
        region: S3Region.UsEast9,
        bucketsUpdated: 1,
        bucketsFailed: ['photos'],
        bucketListFailed: false,
      },
    ]);
    expect(putSpy.mock.calls.filter(([, bucketName]) => bucketName === 'photos')).toHaveLength(4);
  });

  it('does not retry an error other than a failed precondition', async () => {
    iam.failNext('putBucketPolicy', new Error('vendor down'));

    const reports = await syncRoster();

    expect(reports).toStrictEqual([
      {
        region: S3Region.UsEast9,
        bucketsUpdated: 1,
        bucketsFailed: ['photos'],
        bucketListFailed: false,
      },
    ]);
    expect(photosPuts()).toHaveLength(1);
  });

  it("reports bucketListFailed when the region's buckets cannot be listed", async () => {
    iamRegion.listBuckets.mockRejectedValue(new Error('vendor down'));

    await expect(syncRoster()).resolves.toStrictEqual([
      { region: S3Region.UsEast9, bucketsUpdated: 0, bucketsFailed: [], bucketListFailed: true },
    ]);
  });

  it('audits a created policy with trigger role_changed', async () => {
    iamRegion.listBuckets.mockResolvedValue([{ bucketName: 'photos' }]);

    await syncRoster();

    const events = ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item!);
    expect(
      events.map((item) => ({ type: item.type?.S, trigger: item.details?.M?.trigger?.S })),
    ).toStrictEqual([
      { type: 'bucket_policy.created', trigger: 'role_changed' },
      { type: 'bucket_policy.created', trigger: 'role_changed' },
    ]);
  });
});

describe('removeMemberPrincipalFromIamRegions', () => {
  function removeMemberPrincipal() {
    return removeMemberPrincipalFromIamRegions({ orgId: 'org-1', orgProfile, userId: 'member-1' });
  }

  it('removes the principal in each ready iam region', async () => {
    await expect(removeMemberPrincipal()).resolves.toStrictEqual({
      removed: [S3Region.UsEast9],
      failed: [],
    });
    expect(iam.principals.get(TENANT)!.has('member-1')).toBe(false);
    expect(ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input)).toStrictEqual(
      [
        {
          TableName: 'UserInfoTable',
          Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
          UpdateExpression: 'DELETE #principals :ids',
          ExpressionAttributeNames: { '#principals': 'forgeDevPrincipals' },
          ExpressionAttributeValues: { ':ids': { SS: ['member-1'] } },
        },
      ],
    );
  });

  it('reports a region whose removal failed', async () => {
    iam.failNext('removeMember', new Error('vendor down'));

    await expect(removeMemberPrincipal()).resolves.toStrictEqual({
      removed: [],
      failed: [S3Region.UsEast9],
    });
  });

  it('reports the region as failed when its registered-principals set cannot be updated', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    await expect(removeMemberPrincipal()).resolves.toStrictEqual({
      removed: [],
      failed: [S3Region.UsEast9],
    });
  });

  it('skips a region whose tenant is not provisioned', async () => {
    await expect(
      removeMemberPrincipalFromIamRegions({
        orgId: 'org-1',
        orgProfile: undefined,
        userId: 'member-1',
      }),
    ).resolves.toStrictEqual({ removed: [], failed: [] });
  });
});
