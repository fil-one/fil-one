import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { OrgRole, ROSTER_ADMINS_SID, ROSTER_OWNERS_SID, S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';
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
  isRosterRole,
  removeMemberPrincipals,
  rosterAfterChange,
  syncRosterStatements,
} from './iam-policy-fanout.ts';

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);
process.env.FILONE_STAGE = 'test';
const orgProfile = { pk: { S: `ORG#${ORG_ID}` } };
const roster = { owners: ['owner-1'], admins: ['admin-1'] };

const team: BucketPolicy = {
  statement: [{ sid: 'team', effect: 'allow', principal: ['member-1'], action: ['s3:GetObject'] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  ddbMock.reset();
  ssmMock.reset();
  ddbMock.on(PutItemCommand).resolves({});
  iam.principals.clear();
  iam.policies.clear();
  iam.buckets.clear();
  iam.calls.length = 0;
  iam.seedPrincipal(TENANT, 'member-1');
  iamRegion.listBuckets.mockResolvedValue([{ bucketName: 'photos' }, { bucketName: 'backups' }]);
});

describe('rosterAfterChange', () => {
  it('places the changing member at the role they are moving to', async () => {
    mockListMembers.mockResolvedValue([
      { userId: 'owner-1', role: OrgRole.Owner },
      { userId: 'member-1', role: OrgRole.Member },
    ]);

    await expect(
      rosterAfterChange(ORG_ID, { userId: 'member-1', role: OrgRole.Admin }),
    ).resolves.toStrictEqual({ owners: ['owner-1'], admins: ['member-1'] });
    await expect(
      rosterAfterChange(ORG_ID, { userId: 'owner-1', role: OrgRole.Member }),
    ).resolves.toStrictEqual({ owners: [], admins: [] });
  });

  it('names the two roles the console writes onto every policy', () => {
    expect([OrgRole.Owner, OrgRole.Admin].every(isRosterRole)).toBe(true);
    expect([OrgRole.Member, OrgRole.ReadOnly].some(isRosterRole)).toBe(false);
  });
});

describe('syncRosterStatements', () => {
  it('writes the roster statements on every bucket of every iam region and keeps the rest', async () => {
    iam.seedPolicy(TENANT, 'photos', team);

    const report = await syncRosterStatements({ orgId: ORG_ID, orgProfile, roster, actor: ACTOR });

    expect(report).toStrictEqual([
      { region: S3Region.UsEast9, bucketsReached: 2, bucketsFailed: [] },
    ]);
    const photos = iam.policies.get(TENANT)!.get('photos')!.policy;
    expect(photos.statement.map((s) => s.sid)).toStrictEqual([
      ROSTER_OWNERS_SID,
      ROSTER_ADMINS_SID,
      'team',
    ]);
    expect(photos.statement[0]!.principal).toStrictEqual(['owner-1']);
    // A bucket with no policy gets one holding the roster alone.
    expect(iam.policies.get(TENANT)!.get('backups')!.policy.statement).toHaveLength(2);
    // The members the statements name were synced first.
    expect(iam.principals.get(TENANT)!.has('owner-1')).toBe(true);
  });

  it('leaves a policy that already carries the roster alone', async () => {
    iam.seedPolicy(TENANT, 'photos', team);
    await syncRosterStatements({ orgId: ORG_ID, orgProfile, roster, actor: ACTOR });
    const writes = () => iam.calls.filter((c) => c.method === 'putBucketPolicy').length;
    const after = writes();

    await syncRosterStatements({ orgId: ORG_ID, orgProfile, roster, actor: ACTOR });

    expect(writes()).toBe(after);
  });

  it('deletes a policy the roster emptied and reports a bucket a write could not reach', async () => {
    iam.seedPolicy(TENANT, 'photos', {
      statement: [
        { sid: ROSTER_OWNERS_SID, effect: 'allow', principal: ['owner-1'], action: ['s3:*'] },
      ],
    });
    iam.failNext('getBucketPolicy', new Error('vendor down'));

    const report = await syncRosterStatements({
      orgId: ORG_ID,
      orgProfile,
      roster: { owners: [], admins: [] },
      actor: ACTOR,
    });

    // `photos` was read first and failed; `backups` had nothing and needed nothing.
    expect(report[0]).toStrictEqual({
      region: S3Region.UsEast9,
      bucketsReached: 1,
      bucketsFailed: ['photos'],
    });

    const again = await syncRosterStatements({
      orgId: ORG_ID,
      orgProfile,
      roster: { owners: [], admins: [] },
      actor: ACTOR,
    });
    expect(again[0]!.bucketsFailed).toStrictEqual([]);
    expect(iam.policies.get(TENANT)!.has('photos')).toBe(false);
  });

  it('reads again and rewrites when another writer landed first', async () => {
    iam.seedPolicy(TENANT, 'photos', team);
    iam.failNext('putBucketPolicy', new PolicyPreconditionFailedError('photos'));

    const report = await syncRosterStatements({ orgId: ORG_ID, orgProfile, roster, actor: ACTOR });

    expect(report[0]!.bucketsFailed).toStrictEqual([]);
    expect(
      iam.calls.filter((c) => c.method === 'putBucketPolicy' && c.target === 'photos'),
    ).toHaveLength(2);
  });

  it('records each rewritten policy as a role-change write', async () => {
    await syncRosterStatements({ orgId: ORG_ID, orgProfile, roster, actor: ACTOR });

    const events = ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item!);
    const created = events.filter((item) => item.type?.S === 'bucket_policy.created');
    expect(created).toHaveLength(4); // two buckets, intent and completion each
    expect(created[0]!.details?.M?.trigger?.S).toBe('role_change');
  });
});

describe('removeMemberPrincipals', () => {
  it('removes the principal on every ready iam region and names the ones that refused', async () => {
    iam.seedPrincipal(TENANT, 'member-1');

    await expect(
      removeMemberPrincipals({ orgId: 'org-1', orgProfile, userId: 'member-1' }),
    ).resolves.toStrictEqual({
      removed: [S3Region.UsEast9],
      failed: [],
    });
    expect(iam.principals.get(TENANT)!.has('member-1')).toBe(false);

    iam.failNext('removeMember', new Error('vendor down'));
    await expect(
      removeMemberPrincipals({ orgId: 'org-1', orgProfile, userId: 'member-1' }),
    ).resolves.toStrictEqual({
      removed: [],
      failed: [S3Region.UsEast9],
    });
  });

  it('skips a region whose tenant is not provisioned', async () => {
    await expect(
      removeMemberPrincipals({ orgId: 'org-1', orgProfile: undefined, userId: 'member-1' }),
    ).resolves.toStrictEqual({ removed: [], failed: [] });
  });

  it("deletes the member's console credential on every region that removed them", async () => {
    iam.seedPrincipal(TENANT, 'member-1');
    ssmMock.on(DeleteParameterCommand).resolves({});

    await removeMemberPrincipals({ orgId: 'org-1', orgProfile, userId: 'member-1' });

    const [call] = ssmMock.commandCalls(DeleteParameterCommand);
    expect(call!.args[0]!.input).toStrictEqual({
      Name: `/filone/test/forgeDev-s3/member-key/${TENANT}/member-1`,
    });
  });

  it('leaves no credential behind for a region that refused the removal', async () => {
    iam.seedPrincipal(TENANT, 'member-1');
    ssmMock.on(DeleteParameterCommand).resolves({});
    iam.failNext('removeMember', new Error('vendor down'));

    await removeMemberPrincipals({ orgId: 'org-1', orgProfile, userId: 'member-1' });

    // The principal still holds the key there, so the credential has to stay.
    expect(ssmMock.commandCalls(DeleteParameterCommand)).toHaveLength(0);
  });

  it('still reports the region removed when the credential delete fails', async () => {
    iam.seedPrincipal(TENANT, 'member-1');
    ssmMock.on(DeleteParameterCommand).rejects(new Error('ssm down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A parameter left behind costs a signing failure for someone who is no
    // longer in the org; the removal itself still stands.
    await expect(
      removeMemberPrincipals({ orgId: 'org-1', orgProfile, userId: 'member-1' }),
    ).resolves.toStrictEqual({ removed: [S3Region.UsEast9], failed: [] });
    expect(consoleError).toHaveBeenCalledWith(
      '[iam-policy-fanout] Could not delete a member credential',
      expect.objectContaining({ userId: 'member-1' }),
    );
    consoleError.mockRestore();
  });
});
