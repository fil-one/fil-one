import { test, expect } from '@playwright/test';
import type { RotateAccessKeyResponse } from '@filone/shared';
import {
  resolvePersonalOrgId,
  runCleanup,
  seedMembership,
  setMembershipRole,
} from '../destructive/invite.util.ts';
import {
  allow,
  buildBucketPolicy,
  buildCreatorPolicy,
  grantAllToOwner,
  createS3Client,
  createS3ClientWithNewKey,
  emptyAndDeleteBucket,
  generateBucketName,
  getCredentials,
  getS3Outcome,
  listObjects,
  toCanonicalPolicy,
  ConsoleApi,
  type UnboundStatement,
} from './policy.util.ts';

// What membership changes and key and bucket deletion do to policies and keys.
// These change memberships, so the project runs one test at a time. The
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

async function createTrackedBucket(statements: UnboundStatement[] = []): Promise<string> {
  const bucket = generateBucketName('life');
  await owner.createBucket(bucket);
  buckets.push(bucket);
  if (statements.length > 0) {
    await owner.replaceStatements(bucket, [grantAllToOwner(ownerId), ...statements]);
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
    // The Leaver back in the Owner's org as a Member, before the key deletes:
    // a removed member's own delete is refused, and their keys are already gone.
    {
      label: 'leaver seat',
      run: () => seedMembership({ orgId, userId: leaverId, role: 'member', invitedBy: ownerId }),
    },
    ...createdKeys.map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
  await Promise.all([owner.dispose(), member.dispose(), leaver.dispose()]);
});

test('a promotion and a demotion change no policy', { tag: ['@serial', '@api'] }, async () => {
  const adminListStatement = allow([adminId], ['s3:ListBucket'], 'team');
  const bucket = await createTrackedBucket([adminListStatement]);
  const before = toCanonicalPolicy((await owner.readPolicy(bucket)).policy);
  try {
    const promoted = await owner.setRole(memberId, 'admin');
    expect(promoted.status(), await promoted.text()).toBe(200);
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(before);
    // An Admin's own key reaches only what a statement names them for.
    expect(
      await getS3Outcome(listObjects(await createS3ClientWithNewKey(member, createdKeys), bucket)),
    ).toBe('404 NoSuchBucket');

    const demoted = await owner.setRole(memberId, 'member');
    expect(demoted.status(), await demoted.text()).toBe(200);
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(before);
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

test(
  'removing a member takes their keys and every statement naming them',
  { tag: ['@serial', '@api'] },
  async () => {
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
      toCanonicalPolicy(buildBucketPolicy(leaverBucket, [grantAllToOwner(ownerId)])),
    );
    expect(await getS3Outcome(listObjects(createS3Client(key), leaverBucket))).toBe(
      '403 InvalidAccessKeyId',
    );
  },
);

test('a policy naming a removed member is refused', { tag: ['@serial', '@api'] }, async () => {
  const { etag } = await owner.readPolicy(leaverBucket);
  const writeNamingRemovedMember = await owner.putPolicy(leaverBucket, {
    policy: buildBucketPolicy(leaverBucket, [
      grantAllToOwner(ownerId),
      allow([leaverId], ['s3:ListBucket']),
    ]),
    etag,
  });
  const body = await writeNamingRemovedMember.text();
  // A validation refusal carries a message and no code.
  expect({ status: writeNamingRemovedMember.status(), code: JSON.parse(body).code }, body).toEqual({
    status: 400,
    code: undefined,
  });
});

test(
  'a bucket deleted and created again under its name starts from a creator-only policy',
  { tag: ['@serial', '@api'] },
  async () => {
    const bucket = await createTrackedBucket([allow([memberId], ['s3:ListBucket'], 'member-read')]);
    expect([200, 204]).toContain((await owner.deleteBucket(bucket)).status());
    await owner.createBucket(bucket);
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
      toCanonicalPolicy(buildCreatorPolicy(bucket, ownerId)),
    );
  },
);

test('a deleted principal key stops working', { tag: ['@serial', '@api'] }, async () => {
  const bucket = await createTrackedBucket([allow([memberId], ['s3:ListBucket'])]);
  const deleted = await member.createAccessKey();
  createdKeys.push({ api: member, id: deleted.id });
  await member.deleteKey(deleted.id);
  expect(await getS3Outcome(listObjects(createS3Client(deleted), bucket))).toBe(
    '403 InvalidAccessKeyId',
  );
});

test(
  'a rotated principal key is replaced by a working key',
  { tag: ['@serial', '@api'] },
  async () => {
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
  },
);
