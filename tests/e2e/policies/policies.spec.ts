import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetObjectCommand,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { PolicyAction } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  allow,
  buildBucketPolicy,
  buildCreatorPolicy,
  grantAllToOwner,
  createS3ClientWithNewKey,
  deleteObject,
  deny,
  emptyAndDeleteBucket,
  generateBucketName,
  getCredentials,
  getS3Outcome,
  listObjects,
  putObject,
  toCanonicalPolicy,
  ConsoleApi,
  PAYLOAD,
  REGION,
  SEEDED_KEY,
  type UnboundStatement,
} from './policy.util.ts';

// What a bucket policy grants and withholds, read where it is enforced: S3
// calls against the gateway signed with each member's principal-bound key.
//
// A narrowed policy applies to a key the gateway already cached only once the
// revocation arrives, so every check after a narrowing uses a key created after
// the write, which the gateway evaluates fresh. Only the cached-key test polls.

test.describe.configure({ mode: 'serial' });

const ownerId = getCredentials('owner').userId;
const memberId = getCredentials('member').userId;
const seededBucket = generateBucketName('api1');
const secondSeededBucket = generateBucketName('api2');
const memberCreatedBucket = generateBucketName('api3');

let owner: ConsoleApi;
let member: ConsoleApi;
const createdKeys: { api: ConsoleApi; id: string }[] = [];

test.beforeAll(async () => {
  const orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  member = await ConsoleApi.open('member', orgId);
  await owner.createBucket(seededBucket);
  await owner.createBucket(secondSeededBucket);
  const ownerS3 = await createS3ClientWithNewKey(owner, createdKeys);
  await putObject(ownerS3, seededBucket, SEEDED_KEY);
  await putObject(ownerS3, secondSeededBucket, SEEDED_KEY);
});

test.afterAll(async () => {
  // Every bucket and key the file made goes one at a time, each several calls.
  test.setTimeout(180_000);
  await runCleanup([
    ...[seededBucket, secondSeededBucket, memberCreatedBucket].map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => emptyAndDeleteBucket(owner, ownerId, bucket),
    })),
    ...createdKeys.map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
  await owner.dispose();
  await member.dispose();
});

test('1. a new bucket names only its creator', async () => {
  const { policy, etag } = await owner.readPolicy(seededBucket);
  expect(toCanonicalPolicy(policy)).toEqual(
    toCanonicalPolicy(buildCreatorPolicy(seededBucket, ownerId)),
  );
  expect(etag).toEqual(expect.any(String));
});

test('2. the owner key writes, reads and deletes an object', async () => {
  const s3 = await createS3ClientWithNewKey(owner, createdKeys);
  expect(await getS3Outcome(putObject(s3, seededBucket, 'owner-write.txt'))).toBe('ok');
  const got = await s3.send(new GetObjectCommand({ Bucket: seededBucket, Key: 'owner-write.txt' }));
  expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(PAYLOAD);
  expect(await getS3Outcome(deleteObject(s3, seededBucket, 'owner-write.txt'))).toBe('ok');
});

test('3. a member no statement names cannot see the bucket', async () => {
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect(await getS3Outcome(listObjects(s3, seededBucket))).toBe('404 NoSuchBucket');
});

test('4. S3 lists every bucket to the member, the console only theirs', async () => {
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
  const ours = new Set([seededBucket, secondSeededBucket]);
  const byName = (a: string, b: string) => a.localeCompare(b);
  expect(
    Buckets.map((b) => b.Name!)
      .filter((n) => ours.has(n))
      .sort(byName),
  ).toEqual([seededBucket, secondSeededBucket].sort(byName));
  expect((await member.listBucketNames()).filter((n) => ours.has(n))).toEqual([]);
});

test('5. an allow grants exactly its actions on its bucket', async () => {
  await owner.replaceStatements(seededBucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:ListBucket', 's3:GetObject'], 'member-read'),
  ]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  const listed = await listObjects(s3, seededBucket);
  expect(listed.Contents?.map((o) => o.Key)).toEqual([SEEDED_KEY]);
  expect(
    await Promise.all([
      getS3Outcome(s3.send(new GetObjectCommand({ Bucket: seededBucket, Key: SEEDED_KEY }))),
      getS3Outcome(putObject(s3, seededBucket, 'member-write.txt')),
      getS3Outcome(listObjects(s3, secondSeededBucket)),
    ]),
  ).toEqual(['ok', '403 AccessDenied', '404 NoSuchBucket']);
});

test('6. a deny beats an allow', async () => {
  await owner.replaceStatements(seededBucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:ListBucket', 's3:GetObject'], 'member-read'),
    deny([memberId], ['s3:GetObject'], 'no-get'),
  ]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect(
    await Promise.all([
      getS3Outcome(s3.send(new GetObjectCommand({ Bucket: seededBucket, Key: SEEDED_KEY }))),
      getS3Outcome(listObjects(s3, seededBucket)),
    ]),
  ).toEqual(['403 AccessDenied', 'ok']);
});

test('7. a removed grant applies to a key the gateway has cached', async () => {
  await owner.replaceStatements(seededBucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:ListBucket'], 'member-list'),
  ]);
  // A first call makes the gateway cache the key with the grant.
  const cachedS3 = await createS3ClientWithNewKey(member, createdKeys);
  expect(await getS3Outcome(listObjects(cachedS3, seededBucket))).toBe('ok');

  await owner.replaceStatements(seededBucket, [grantAllToOwner(ownerId)]);
  await expect
    .poll(() => getS3Outcome(listObjects(cachedS3, seededBucket)), { timeout: 30_000 })
    .toBe('404 NoSuchBucket');
});

test('8. a write under a stale If-Match is refused with 412 POLICY_CONFLICT', async () => {
  const { etag: stale } = await owner.readPolicy(seededBucket);
  await owner.replaceStatements(seededBucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:ListBucket']),
  ]);
  const before = await owner.readPolicy(seededBucket);
  const res = await owner.putPolicy(seededBucket, {
    policy: buildBucketPolicy(seededBucket, [grantAllToOwner(ownerId)]),
    etag: stale,
  });
  expect([res.status(), (await res.json()).code]).toEqual([412, 'POLICY_CONFLICT']);
  expect(await owner.readPolicy(seededBucket)).toEqual(before);
});

test('9. creating a policy under If-None-Match: * where one exists is refused with 412 POLICY_CONFLICT', async () => {
  const res = await owner.putPolicy(seededBucket, {
    policy: buildBucketPolicy(seededBucket, [grantAllToOwner(ownerId)]),
  });
  expect([res.status(), (await res.json()).code]).toEqual([412, 'POLICY_CONFLICT']);
});

const refusedPolicies: [string, UnboundStatement[]][] = [
  [
    '10a. a policy with an unknown action is refused',
    [{ ...allow([memberId], ['s3:GetObject']), Action: ['s3:Unknown' as PolicyAction] }],
  ],
  [
    '10b. a policy with * inside a Principal list is refused',
    [{ ...allow([memberId], ['s3:GetObject']), Principal: { AWS: ['*'] } }],
  ],
  ['10c. a policy with no statements is refused', []],
  [
    '10d. a policy naming a principal id nobody in the tenant holds is refused',
    [grantAllToOwner(ownerId), allow([randomUUID()], ['s3:GetObject'])],
  ],
];
for (const [title, statements] of refusedPolicies) {
  test(title, async () => {
    const { etag } = await owner.readPolicy(seededBucket);
    const res = await owner.putPolicy(seededBucket, {
      policy: buildBucketPolicy(seededBucket, statements),
      etag,
    });
    const body = await res.text();
    // A validation refusal carries a message and no code.
    expect({ status: res.status(), code: JSON.parse(body).code }, body).toEqual({
      status: 400,
      code: undefined,
    });
  });
}

test('11. a statement may take any Sid', async () => {
  const statements = [
    allow([ownerId], ['s3:*'], 'filone-custom'),
    allow([memberId], ['s3:ListBucket'], 'team'),
  ];
  await owner.replaceStatements(secondSeededBucket, statements);
  expect(toCanonicalPolicy((await owner.readPolicy(secondSeededBucket)).policy)).toEqual(
    toCanonicalPolicy(buildBucketPolicy(secondSeededBucket, statements)),
  );
  await owner.replaceStatements(secondSeededBucket, [grantAllToOwner(ownerId)]);
});

test('12. a member cannot read or write a policy', async () => {
  const statuses = [
    (await member.fetchPolicyResponse(seededBucket)).status(),
    (
      await member.putPolicy(seededBucket, {
        policy: buildBucketPolicy(seededBucket, [allow([memberId], ['s3:*'])]),
      })
    ).status(),
  ];
  expect(statuses).toEqual([403, 403]);
});

test('13. a deny naming everyone locks the owner out of S3 but not out of the policy', async () => {
  await owner.replaceStatements(secondSeededBucket, [
    grantAllToOwner(ownerId),
    deny('*', ['s3:*'], 'lockdown'),
  ]);
  expect(
    await getS3Outcome(
      listObjects(await createS3ClientWithNewKey(owner, createdKeys), secondSeededBucket),
    ),
  ).toBe('404 NoSuchBucket');
  await owner.replaceStatements(secondSeededBucket, [grantAllToOwner(ownerId)]);
  expect(
    await getS3Outcome(
      listObjects(await createS3ClientWithNewKey(owner, createdKeys), secondSeededBucket),
    ),
  ).toBe('ok');
});

test('14a. deleting the policy leaves the bucket to service keys alone', async () => {
  // Without If-Match, as on S3, the delete is unconditional.
  expect((await owner.deletePolicy(secondSeededBucket)).status()).toBe(204);
  const gone = await owner.fetchPolicyResponse(secondSeededBucket);
  expect([gone.status(), (await gone.json()).code]).toEqual([404, 'POLICY_NOT_FOUND']);
  expect(
    await getS3Outcome(
      listObjects(await createS3ClientWithNewKey(owner, createdKeys), secondSeededBucket),
    ),
  ).toBe('404 NoSuchBucket');
});

test('14b. a write without a precondition creates a policy where none exists', async () => {
  const created = await owner.putPolicy(secondSeededBucket, {
    policy: buildBucketPolicy(secondSeededBucket, [grantAllToOwner(ownerId)]),
    unconditional: true,
  });
  expect([created.status(), created.headers().etag]).toEqual([204, expect.any(String)]);
});

const presignGet = (bucket: string) =>
  member.send('POST', `/presign?region=${REGION}`, [{ op: 'getObject', bucket, key: SEEDED_KEY }]);

test('15a. a member presigned GET works where a statement grants them s3:GetObject', async () => {
  await owner.replaceStatements(seededBucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:GetObject']),
  ]);
  const granted = await presignGet(seededBucket);
  expect(granted.status(), await granted.text()).toBe(200);
  const { items } = (await granted.json()) as { items: { url: string }[] };
  const got = await fetch(items[0].url);
  expect([got.status, await got.text()]).toEqual([200, PAYLOAD.toString()]);
});

test('15b. a member presigned GET is refused for a bucket no statement names them in', async () => {
  // The URL would carry the tenant's key, which can access every bucket, so the
  // console refuses to issue one for a bucket outside the member's policies,
  // and answers as it would for a bucket that does not exist.
  const refused = await presignGet(secondSeededBucket);
  expect([refused.status(), ((await refused.json()) as { message: string }).message]).toEqual([
    404,
    'Bucket not found',
  ]);
});

test('16. a principal-bound key cannot create or delete buckets', async () => {
  const s3 = await createS3ClientWithNewKey(owner, createdKeys);
  expect(
    await Promise.all([
      getS3Outcome(s3.send(new CreateBucketCommand({ Bucket: generateBucketName('nope') }))),
      getS3Outcome(s3.send(new DeleteBucketCommand({ Bucket: secondSeededBucket }))),
    ]),
  ).toEqual(['403 AccessDenied', '403 AccessDenied']);
});

test('17. a bucket a member creates names only its creator', async () => {
  await member.createBucket(memberCreatedBucket);
  expect(toCanonicalPolicy((await owner.readPolicy(memberCreatedBucket)).policy)).toEqual(
    toCanonicalPolicy(buildCreatorPolicy(memberCreatedBucket, memberId)),
  );
});
