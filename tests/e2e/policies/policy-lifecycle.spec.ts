import type { S3Client } from '@aws-sdk/client-s3';
import { test, expect } from '@playwright/test';
import { ROSTER_ADMIN_ACTIONS } from '@filone/shared';
import type { CreateAccessKeyResponse, PolicyStatement } from '@filone/shared';
import {
  resolvePersonalOrgId,
  runCleanup,
  seedMembership,
  setMembershipRole,
} from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  REGION,
  adminsStatement,
  allow,
  credentials,
  listObjects,
  outcome,
  ownersStatement,
  removeBucket,
  rosterPolicy,
  s3For,
  uniqueBucketName,
} from './policy.util.ts';

// What membership changes and key and bucket deletion do to policies and keys.
// These move the org's roster, so the project runs one test at a time. The
// removal case takes out the Leaver, whom no other spec uses, and seats them
// again afterwards.

test.describe.configure({ mode: 'serial' });

const ownerId = credentials('owner').userId;
const adminId = credentials('admin').userId;
const memberId = credentials('member').userId;
const leaverId = credentials('leaver').userId;
const byName = (a: string, b: string) => a.localeCompare(b);

let orgId: string;
let owner: ConsoleApi;
let member: ConsoleApi;
let leaver: ConsoleApi;
const buckets: string[] = [];
const minted: { api: ConsoleApi; id: string }[] = [];

async function mint(api: ConsoleApi): Promise<CreateAccessKeyResponse> {
  const key = await api.mintKey();
  minted.push({ api, id: key.id });
  return key;
}

async function freshS3(api: ConsoleApi): Promise<S3Client> {
  return s3For(await mint(api));
}

async function newBucket(statements: PolicyStatement[] = []): Promise<string> {
  const bucket = uniqueBucketName('life');
  await owner.createBucket(bucket);
  buckets.push(bucket);
  if (statements.length > 0) {
    await owner.setStatements(bucket, [...rosterPolicy(ownerId, adminId).statement, ...statements]);
  }
  return bucket;
}

/** The Leaver back in the Owner's org as a Member, whatever B2 did. */
const restoreLeaver = {
  label: 'leaver seat',
  run: () => seedMembership({ orgId, userId: leaverId, role: 'member', invitedBy: ownerId }),
};

test.beforeAll(async () => {
  orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  member = await ConsoleApi.open('member', orgId);
  leaver = await ConsoleApi.open('leaver', orgId);
});

test.afterAll(async () => {
  // Every bucket and key the file made goes one at a time, each several calls.
  test.setTimeout(180_000);
  await runCleanup([
    ...buckets.map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => removeBucket(owner, ownerId, bucket),
    })),
    ...minted.map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
  await Promise.all([owner.dispose(), member.dispose(), leaver.dispose()]);
});

test('B1. a promotion and a demotion rewrite the admins statement on every bucket', async () => {
  const team = allow([adminId], ['s3:ListBucket'], 'team');
  const bucket = await newBucket([team]);
  try {
    const promoted = await owner.setRole(memberId, 'admin');
    expect(promoted.status(), await promoted.text()).toBe(200);
    const { policySync } = await promoted.json();
    expect(policySync).toEqual([
      { region: REGION, bucketsReached: expect.any(Number), bucketsFailed: [] },
    ]);

    const { policy } = await owner.readPolicy(bucket);
    expect(policy).toEqual({
      statement: [
        ownersStatement(ownerId),
        {
          sid: 'filone-admins',
          effect: 'allow',
          principal: expect.any(Array),
          action: ROSTER_ADMIN_ACTIONS,
        },
        team,
      ],
    });
    expect([...(policy.statement[1].principal as string[])].sort(byName)).toEqual(
      [adminId, memberId].sort(byName),
    );
    expect(await outcome(listObjects(await freshS3(member), bucket))).toBe('ok');

    const demoted = await owner.setRole(memberId, 'member');
    expect(demoted.status(), await demoted.text()).toBe(200);
    expect((await owner.readPolicy(bucket)).policy).toEqual({
      statement: [ownersStatement(ownerId), adminsStatement(adminId), team],
    });
    expect(await outcome(listObjects(await freshS3(member), bucket))).toBe('404 NoSuchBucket');
  } finally {
    await runCleanup([
      {
        label: 'member role',
        run: () => setMembershipRole({ orgId, userId: memberId, role: 'member' }),
      },
    ]);
  }
});

test('B2. removing a member takes their keys and every statement naming them', async () => {
  const bucket = await newBucket([allow([leaverId], ['s3:ListBucket'], 'leaver-only')]);
  // Minted and not yet used, so the gateway holds nothing cached for it.
  const key = await mint(leaver);
  const byId = (a: string, b: string) => a.localeCompare(b);
  const held = (await leaver.listKeyIds()).sort(byId);
  expect(held).toContain(key.id);
  try {
    const removed = await owner.removeMember(leaverId);
    expect(removed.status(), await removed.text()).toBe(200);
    const { revokedKeys = [] } = await removed.json();
    expect(revokedKeys.map((k: { id: string }) => k.id).sort(byId)).toEqual(held);

    expect((await owner.readPolicy(bucket)).policy).toEqual(rosterPolicy(ownerId, adminId));
    expect(await outcome(listObjects(s3For(key), bucket))).toBe('403 InvalidAccessKeyId');

    // A removed member is no longer a principal of the tenant.
    const { etag } = await owner.readPolicy(bucket);
    const named = await owner.putPolicy(bucket, {
      policy: { statement: [ownersStatement(ownerId), allow([leaverId], ['s3:ListBucket'])] },
      etag,
    });
    expect(named.status()).toBe(400);
  } finally {
    await runCleanup([restoreLeaver]);
  }
});

test('B3. a bucket deleted and created again under its name starts from the roster', async () => {
  const bucket = await newBucket([allow([memberId], ['s3:ListBucket'], 'member-read')]);
  expect([200, 204]).toContain((await owner.deleteBucket(bucket)).status());
  await owner.createBucket(bucket);
  expect((await owner.readPolicy(bucket)).policy).toEqual(rosterPolicy(ownerId, adminId));
});

test('B4. a deleted principal key stops working and one cannot be rotated', async () => {
  const bucket = await newBucket([allow([memberId], ['s3:ListBucket'])]);
  const deleted = await mint(member);
  await member.deleteKey(deleted.id);
  expect(await outcome(listObjects(s3For(deleted), bucket))).toBe('403 InvalidAccessKeyId');

  const kept = await mint(member);
  expect((await member.rotateKey(kept.id)).status()).toBe(409);
  expect(await outcome(listObjects(s3For(kept), bucket))).toBe('ok');
});
