import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetObjectCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { test, expect } from '@playwright/test';
import { ROSTER_ADMIN_ACTIONS } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  PAYLOAD,
  REGION,
  SEEDED_KEY,
  allow,
  credentials,
  deleteObject,
  deny,
  listObjects,
  outcome,
  ownersStatement,
  putObject,
  rosterPolicy,
  removeBucket,
  s3For,
  uniqueBucketName,
} from './policy.util.ts';

// What a bucket policy grants and withholds, read where it is enforced: S3
// calls against the gateway signed with each member's principal-bound key.
//
// A narrowed policy reaches a key the gateway already cached only once the
// revocation arrives, so every check after a narrowing uses a key minted after
// the write, which the gateway evaluates fresh. Case 7 is the one that watches
// the revocation reach a cached key, and the only one that waits.

test.describe.configure({ mode: 'serial' });

const ownerId = credentials('owner').userId;
const adminId = credentials('admin').userId;
const memberId = credentials('member').userId;
const B1 = uniqueBucketName('api1');
const B2 = uniqueBucketName('api2');
const B3 = uniqueBucketName('api3');

let owner: ConsoleApi;
let member: ConsoleApi;
const minted: { api: ConsoleApi; id: string }[] = [];

async function freshS3(api: ConsoleApi): Promise<S3Client> {
  const key = await api.mintKey();
  minted.push({ api, id: key.id });
  return s3For(key);
}

test.beforeAll(async () => {
  const orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  member = await ConsoleApi.open('member', orgId);
  await owner.createBucket(B1);
  await owner.createBucket(B2);
  const ownerS3 = await freshS3(owner);
  await putObject(ownerS3, B1, SEEDED_KEY);
  await putObject(ownerS3, B2, SEEDED_KEY);
});

test.afterAll(async () => {
  await runCleanup([
    ...[B1, B2, B3].map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => removeBucket(owner, ownerId, bucket),
    })),
    ...minted.map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
  await owner.dispose();
  await member.dispose();
});

test('1. a new bucket carries the roster statements', async () => {
  const { policy, etag } = await owner.readPolicy(B1);
  expect(policy).toEqual(rosterPolicy(ownerId, adminId));
  expect(etag).toEqual(expect.any(String));
});

test('2. the owner key writes, reads and deletes an object', async () => {
  const s3 = await freshS3(owner);
  expect(await outcome(putObject(s3, B1, 'owner-write.txt'))).toBe('ok');
  const got = await s3.send(new GetObjectCommand({ Bucket: B1, Key: 'owner-write.txt' }));
  expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(PAYLOAD);
  expect(await outcome(deleteObject(s3, B1, 'owner-write.txt'))).toBe('ok');
});

test('3. a member no statement names cannot see the bucket', async () => {
  const s3 = await freshS3(member);
  expect(await outcome(listObjects(s3, B1))).toBe('404 NoSuchBucket');
});

test('4. S3 lists every bucket to the member, the console only theirs', async () => {
  const s3 = await freshS3(member);
  const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
  const ours = new Set([B1, B2]);
  const byName = (a: string, b: string) => a.localeCompare(b);
  expect(
    Buckets.map((b) => b.Name!)
      .filter((n) => ours.has(n))
      .sort(byName),
  ).toEqual([B1, B2].sort(byName));
  expect((await member.listBucketNames()).filter((n) => ours.has(n))).toEqual([]);
});

let cachedMemberS3: S3Client;

test('5. an allow grants exactly its actions on its bucket', async () => {
  await owner.setStatements(B1, [
    ownersStatement(ownerId),
    allow([memberId], ['s3:ListBucket', 's3:GetObject'], 'member-read'),
  ]);
  cachedMemberS3 = await freshS3(member);
  const listed = await listObjects(cachedMemberS3, B1);
  expect(listed.Contents?.map((o) => o.Key)).toEqual([SEEDED_KEY]);
  expect(
    await Promise.all([
      outcome(cachedMemberS3.send(new GetObjectCommand({ Bucket: B1, Key: SEEDED_KEY }))),
      outcome(putObject(cachedMemberS3, B1, 'member-write.txt')),
      outcome(listObjects(cachedMemberS3, B2)),
    ]),
  ).toEqual(['ok', '403 AccessDenied', '404 NoSuchBucket']);
});

test('6. a deny beats an allow', async () => {
  await owner.setStatements(B1, [
    ownersStatement(ownerId),
    allow([memberId], ['s3:ListBucket', 's3:GetObject'], 'member-read'),
    deny([memberId], ['s3:GetObject'], 'no-get'),
  ]);
  const s3 = await freshS3(member);
  expect(
    await Promise.all([
      outcome(s3.send(new GetObjectCommand({ Bucket: B1, Key: SEEDED_KEY }))),
      outcome(listObjects(s3, B1)),
    ]),
  ).toEqual(['403 AccessDenied', 'ok']);
});

test('7. taking a grant away reaches a key the gateway cached', async () => {
  await owner.setStatements(B1, [ownersStatement(ownerId)]);
  await expect
    .poll(() => outcome(listObjects(cachedMemberS3, B1)), { timeout: 30_000 })
    .toBe('404 NoSuchBucket');
});

test('8. a write under a stale etag loses', async () => {
  const { etag: stale } = await owner.readPolicy(B1);
  await owner.setStatements(B1, [ownersStatement(ownerId), allow([memberId], ['s3:ListBucket'])]);
  const before = await owner.readPolicy(B1);
  const res = await owner.putPolicy(B1, {
    policy: { statement: [ownersStatement(ownerId)] },
    etag: stale,
  });
  expect([res.status(), (await res.json()).code]).toEqual([409, 'POLICY_CONFLICT']);
  expect(await owner.readPolicy(B1)).toEqual(before);
});

test('9. creating a policy where one exists loses', async () => {
  const res = await owner.putPolicy(B1, { policy: { statement: [ownersStatement(ownerId)] } });
  expect([res.status(), (await res.json()).code]).toEqual([409, 'POLICY_CONFLICT']);
});

test('10. invalid documents are refused', async () => {
  const { etag } = await owner.readPolicy(B1);
  const statuses = [];
  for (const statement of [
    [{ effect: 'allow', principal: [memberId], action: ['s3:Unknown'] }],
    [{ effect: 'allow', principal: ['*'], action: ['s3:GetObject'] }],
    [],
    [ownersStatement(ownerId), allow(['no-such-principal'], ['s3:GetObject'])],
  ]) {
    statuses.push((await owner.putPolicy(B1, { policy: { statement }, etag })).status());
  }
  expect(statuses).toEqual([400, 400, 400, 400]);
});

test('11. a policy may drop the roster statements and use any name', async () => {
  const statement = [
    allow([ownerId], ['s3:*'], 'filone-custom'),
    allow([memberId], ['s3:ListBucket'], 'team'),
  ];
  await owner.setStatements(B2, statement);
  expect((await owner.readPolicy(B2)).policy).toEqual({ statement });
  await owner.setStatements(B2, [ownersStatement(ownerId)]);
});

test('12. a member cannot read or write a policy', async () => {
  const statuses = [
    (await member.getPolicy(B1)).status(),
    (await member.putPolicy(B1, { policy: { statement: [allow([memberId], ['s3:*'])] } })).status(),
  ];
  expect(statuses).toEqual([403, 403]);
});

test('13. a deny naming everyone locks the owner out of S3 but not out of the policy', async () => {
  await owner.setStatements(B2, [ownersStatement(ownerId), deny('*', ['s3:*'], 'lockdown')]);
  expect(await outcome(listObjects(await freshS3(owner), B2))).toBe('404 NoSuchBucket');
  await owner.setStatements(B2, [ownersStatement(ownerId)]);
  expect(await outcome(listObjects(await freshS3(owner), B2))).toBe('ok');
});

test('14. deleting the policy leaves the bucket to service keys alone', async () => {
  const { etag } = await owner.readPolicy(B2);
  expect((await owner.deletePolicy(B2)).status()).toBe(400);
  expect((await owner.deletePolicy(B2, etag)).status()).toBe(204);
  const gone = await owner.getPolicy(B2);
  expect([gone.status(), (await gone.json()).code]).toEqual([404, 'POLICY_NOT_FOUND']);
  expect(await outcome(listObjects(await freshS3(owner), B2))).toBe('404 NoSuchBucket');

  const created = await owner.putPolicy(B2, { policy: { statement: [ownersStatement(ownerId)] } });
  expect([created.status(), await created.json()]).toEqual([
    201,
    { etag: expect.any(String), created: true },
  ]);
});

test('15. a member presigned GET follows their grants', async () => {
  await owner.setStatements(B1, [ownersStatement(ownerId), allow([memberId], ['s3:GetObject'])]);
  const fetchPresigned = async (bucket: string) => {
    const res = await member.send('POST', `/presign?region=${REGION}`, [
      { op: 'getObject', bucket, key: SEEDED_KEY },
    ]);
    expect(res.status(), await res.text()).toBe(200);
    const { items } = (await res.json()) as { items: { url: string }[] };
    const got = await fetch(items[0].url);
    return [
      got.status,
      got.ok ? await got.text() : (await got.text()).match(/<Code>(\w+)<\/Code>/)?.[1],
    ];
  };
  expect([await fetchPresigned(B1), await fetchPresigned(B2)]).toEqual([
    [200, PAYLOAD.toString()],
    [404, 'NoSuchBucket'],
  ]);
});

test('16. a principal-bound key cannot create or delete buckets', async () => {
  const s3 = await freshS3(owner);
  expect(
    await Promise.all([
      outcome(s3.send(new CreateBucketCommand({ Bucket: uniqueBucketName('nope') }))),
      outcome(s3.send(new DeleteBucketCommand({ Bucket: B2 }))),
    ]),
  ).toEqual(['403 AccessDenied', '403 AccessDenied']);
});

test('17. a bucket a member creates also names its creator', async () => {
  await member.createBucket(B3);
  expect((await owner.readPolicy(B3)).policy).toEqual({
    statement: [
      ...rosterPolicy(ownerId, adminId).statement,
      {
        sid: 'filone-creator',
        effect: 'allow',
        principal: [memberId],
        action: ROSTER_ADMIN_ACTIONS,
      },
    ],
  });
});
