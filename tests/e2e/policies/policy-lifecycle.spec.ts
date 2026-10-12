import { test, expect } from '@playwright/test';
import { ROSTER_ADMIN_ACTIONS } from '@filone/shared';
import type { PolicyStatement, RotateAccessKeyResponse } from '@filone/shared';
import {
  resolvePersonalOrgId,
  runCleanup,
  seedMembership,
  setMembershipRole,
} from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  REGION,
  buildAdminsStatement,
  allow,
  getCredentials,
  listObjects,
  getS3Outcome,
  buildOwnersStatement,
  emptyAndDeleteBucket,
  buildRosterPolicy,
  createS3Client,
  createS3ClientWithNewKey,
  generateBucketName,
  toCanonicalPolicy,
} from './policy.util.ts';

// What membership changes and key and bucket deletion do to policies and keys.
// These move the org's roster, so the project runs one test at a time. The
// removal case takes out the Leaver, whom no other spec uses, and the file
// seats them again when it finishes.

test.describe.configure({ mode: 'serial' });

const ownerId = getCredentials('owner').userId;
const adminId = getCredentials('admin').userId;
const memberId = getCredentials('member').userId;
const leaverId = getCredentials('leaver').userId;

let orgId: string;
let owner: ConsoleApi;
let member: ConsoleApi;
let leaver: ConsoleApi;
const buckets: string[] = [];
const createdKeys: { api: ConsoleApi; id: string }[] = [];

async function createTrackedBucket(statements: PolicyStatement[] = []): Promise<string> {
  const bucket = generateBucketName('life');
  await owner.createBucket(bucket);
  buckets.push(bucket);
  if (statements.length > 0) {
    await owner.replaceStatements(bucket, [
      ...buildRosterPolicy(ownerId, adminId).Statement,
      ...statements,
    ]);
  }
  return bucket;
}

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
      run: () => emptyAndDeleteBucket(owner, ownerId, bucket),
    })),
    ...createdKeys.map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
    // The Leaver back in the Owner's org as a Member.
    {
      label: 'leaver seat',
      run: () => seedMembership({ orgId, userId: leaverId, role: 'member', invitedBy: ownerId }),
    },
  ]);
  await Promise.all([owner.dispose(), member.dispose(), leaver.dispose()]);
});

test('B1. a promotion and a demotion rewrite the admins statement on every bucket', async () => {
  const adminListStatement = allow([adminId], ['s3:ListBucket'], 'team');
  const bucket = await createTrackedBucket([adminListStatement]);
  try {
    const promoted = await owner.setRole(memberId, 'admin');
    expect(promoted.status(), await promoted.text()).toBe(200);
    const { policySyncReports } = await promoted.json();
    expect(policySyncReports).toEqual([
      {
        region: REGION,
        bucketsUpdated: expect.any(Number),
        bucketsFailed: [],
        bucketListFailed: false,
      },
    ]);

    const { policy } = await owner.readPolicy(bucket);
    expect(toCanonicalPolicy(policy)).toEqual(
      toCanonicalPolicy({
        Statement: [
          buildOwnersStatement(ownerId),
          {
            Sid: 'filone-admins',
            Effect: 'Allow',
            Principal: [adminId, memberId],
            Action: ROSTER_ADMIN_ACTIONS,
          },
          adminListStatement,
        ],
      }),
    );
    expect(
      await getS3Outcome(listObjects(await createS3ClientWithNewKey(member, createdKeys), bucket)),
    ).toBe('ok');

    const demoted = await owner.setRole(memberId, 'member');
    expect(demoted.status(), await demoted.text()).toBe(200);
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
      toCanonicalPolicy({
        Statement: [
          buildOwnersStatement(ownerId),
          buildAdminsStatement(adminId),
          adminListStatement,
        ],
      }),
    );

    expect(
      await getS3Outcome(listObjects(await createS3ClientWithNewKey(member, createdKeys), bucket)),
    ).toBe('404 NoSuchBucket');
  } finally {
    await runCleanup([
      {
        label: 'member role',
        run: () => setMembershipRole({ orgId, userId: memberId, role: 'member' }),
      },
    ]);
  }
});

let leaverBucket: string;

test('B2a. removing a member takes their keys and every statement naming them', async () => {
  leaverBucket = await createTrackedBucket([allow([leaverId], ['s3:ListBucket'], 'leaver-only')]);
  // Created and not yet used, so the gateway holds nothing cached for it.
  const key = await leaver.createAccessKey();
  createdKeys.push({ api: leaver, id: key.id });
  const byId = (a: string, b: string) => a.localeCompare(b);
  const leaverKeyIds = (await leaver.listKeyIds()).sort(byId);
  expect(leaverKeyIds).toContain(key.id);
  const removed = await owner.removeMember(leaverId);
  expect(removed.status(), await removed.text()).toBe(200);
  const { keysRevoked = [] } = await removed.json();
  expect(keysRevoked.map((k: { id: string }) => k.id).sort(byId)).toEqual(leaverKeyIds);

  expect(toCanonicalPolicy((await owner.readPolicy(leaverBucket)).policy)).toEqual(
    toCanonicalPolicy(buildRosterPolicy(ownerId, adminId)),
  );
  expect(await getS3Outcome(listObjects(createS3Client(key), leaverBucket))).toBe(
    '403 InvalidAccessKeyId',
  );
});

test('B2b. a policy naming a removed member is refused', async () => {
  const { etag } = await owner.readPolicy(leaverBucket);
  const writeNamingRemovedMember = await owner.putPolicy(leaverBucket, {
    policy: {
      Statement: [buildOwnersStatement(ownerId), allow([leaverId], ['s3:ListBucket'])],
    },
    etag,
  });
  const body = await writeNamingRemovedMember.text();
  // A validation refusal carries a message and no code.
  expect({ status: writeNamingRemovedMember.status(), code: JSON.parse(body).code }, body).toEqual({
    status: 400,
    code: undefined,
  });
});

test('B3. a bucket deleted and created again under its name starts from the roster', async () => {
  const bucket = await createTrackedBucket([allow([memberId], ['s3:ListBucket'], 'member-read')]);
  expect([200, 204]).toContain((await owner.deleteBucket(bucket)).status());
  await owner.createBucket(bucket);
  expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
    toCanonicalPolicy(buildRosterPolicy(ownerId, adminId)),
  );
});

test('B4a. a deleted principal key stops working', async () => {
  const bucket = await createTrackedBucket([allow([memberId], ['s3:ListBucket'])]);
  const deleted = await member.createAccessKey();
  createdKeys.push({ api: member, id: deleted.id });
  await member.deleteKey(deleted.id);
  expect(await getS3Outcome(listObjects(createS3Client(deleted), bucket))).toBe(
    '403 InvalidAccessKeyId',
  );
});

test('B4b. a rotated principal key is replaced by a working key', async () => {
  const bucket = await createTrackedBucket([allow([memberId], ['s3:ListBucket'])]);
  const old = await member.createAccessKey();
  createdKeys.push({ api: member, id: old.id });
  const rotated = await member.rotateKey(old.id);
  expect(rotated.status(), await rotated.text()).toBe(201);
  const replacement = (await rotated.json()) as RotateAccessKeyResponse;
  createdKeys.push({ api: member, id: replacement.id });
  expect(replacement.previousKeyRevoked).toBe(true);
  expect(await getS3Outcome(listObjects(createS3Client(replacement), bucket))).toBe('ok');
  expect(await getS3Outcome(listObjects(createS3Client(old), bucket))).toBe(
    '403 InvalidAccessKeyId',
  );
});
