import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { test, expect } from '@playwright/test';
import type { PolicyStatement } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  PAYLOAD,
  SEEDED_KEY,
  allow,
  credentials,
  deleteObject,
  deny,
  listObjects,
  outcome,
  ownersStatement,
  putObject,
  removeBucket,
  s3For,
  uniqueBucketName,
} from './policy.util.ts';

// Which S3 operations each action admits, read at the gateway. Several actions
// share a storage command (`s3:GetObject` and `s3:ListBucket` both retrieve,
// `s3:PutObject` carries the right to remove), so only the gateway's cached
// action set tells them apart; these cases pin that it does.
//
// Every case names its statements on a fresh bucket and checks them with a key
// minted after the write. Case A6 is the one that reuses a cached key, because
// what it tests is a widening reaching one.

const ownerId = credentials('owner').userId;
const memberId = credentials('member').userId;

let owner: ConsoleApi;
let admin: ConsoleApi;
let member: ConsoleApi;
let ownerS3: S3Client;
const buckets: string[] = [];
const minted: { api: ConsoleApi; id: string }[] = [];

async function freshS3(api: ConsoleApi): Promise<S3Client> {
  const key = await api.mintKey();
  minted.push({ api, id: key.id });
  return s3For(key);
}

/** A bucket holding SEEDED_KEY whose policy is the owners plus `statements`. */
async function bucketWith(
  statements: PolicyStatement[],
  { versioning = false } = {},
): Promise<string> {
  const bucket = uniqueBucketName('enf');
  await owner.createBucket(bucket, { versioning });
  buckets.push(bucket);
  await putObject(ownerS3, bucket, SEEDED_KEY);
  await owner.setStatements(bucket, [ownersStatement(ownerId), ...statements]);
  return bucket;
}

const get = (s3: S3Client, bucket: string, VersionId?: string) =>
  s3.send(new GetObjectCommand({ Bucket: bucket, Key: SEEDED_KEY, VersionId }));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  admin = await ConsoleApi.open('admin', orgId);
  member = await ConsoleApi.open('member', orgId);
  ownerS3 = await freshS3(owner);
});

test.afterAll(async () => {
  await runCleanup([
    ...buckets.map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => removeBucket(owner, ownerId, bucket),
    })),
    ...minted.map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
  await Promise.all([owner.dispose(), admin.dispose(), member.dispose()]);
});

test('A1. a write grant does not carry deletion', async () => {
  const bucket = await bucketWith([allow([memberId], ['s3:PutObject'])]);
  const s3 = await freshS3(member);
  expect([
    await outcome(putObject(s3, bucket, 'member.txt')),
    await outcome(deleteObject(s3, bucket, SEEDED_KEY)),
  ]).toEqual(['ok', '403 AccessDenied']);
});

test('A2. a list grant does not carry reading', async () => {
  const bucket = await bucketWith([allow([memberId], ['s3:ListBucket'])]);
  const s3 = await freshS3(member);
  expect([await outcome(listObjects(s3, bucket)), await outcome(get(s3, bucket))]).toEqual([
    'ok',
    '403 AccessDenied',
  ]);
});

test('A3. a deny carves one action out of s3:*', async () => {
  const bucket = await bucketWith([
    allow([memberId], ['s3:*']),
    deny([memberId], ['s3:DeleteObject']),
  ]);
  const s3 = await freshS3(member);
  expect([
    await outcome(putObject(s3, bucket, 'member.txt')),
    await outcome(get(s3, bucket)),
    await outcome(deleteObject(s3, bucket, SEEDED_KEY)),
  ]).toEqual(['ok', 'ok', '403 AccessDenied']);
});

test('A4. a deny naming one member leaves an allow for everyone to the rest', async () => {
  const bucket = await bucketWith([
    allow('*', ['s3:ListBucket', 's3:GetObject']),
    deny([memberId], ['s3:ListBucket']),
  ]);
  const memberS3 = await freshS3(member);
  const adminS3 = await freshS3(admin);
  expect([
    await outcome(listObjects(memberS3, bucket)),
    await outcome(get(memberS3, bucket)),
    await outcome(listObjects(adminS3, bucket)),
  ]).toEqual(['403 AccessDenied', 'ok', 'ok']);
});

test('A5. actions granted across statements add up', async () => {
  const bucket = await bucketWith([
    allow([memberId], ['s3:ListBucket'], 'list'),
    allow([memberId], ['s3:GetObject'], 'read'),
  ]);
  const s3 = await freshS3(member);
  expect([
    await outcome(listObjects(s3, bucket)),
    await outcome(get(s3, bucket)),
    await outcome(putObject(s3, bucket, 'member.txt')),
  ]).toEqual(['ok', 'ok', '403 AccessDenied']);
});

test('A6. widening a grant reaches a key the gateway cached', async () => {
  const bucket = await bucketWith([allow([memberId], ['s3:ListBucket'])]);
  const s3 = await freshS3(member);
  expect(await outcome(listObjects(s3, bucket))).toBe('ok');
  expect(await outcome(putObject(s3, bucket, 'member.txt'))).toBe('403 AccessDenied');

  await owner.setStatements(bucket, [
    ownersStatement(ownerId),
    allow([memberId], ['s3:ListBucket', 's3:PutObject']),
  ]);
  // The one wait here: the rotation reaching the gateway's cache is the subject.
  await expect
    .poll(() => outcome(putObject(s3, bucket, 'member.txt')), { timeout: 30_000 })
    .toBe('ok');
});

test('A7. a copy needs a read on its source bucket', async () => {
  const source = await bucketWith([]);
  const target = await bucketWith([allow([memberId], ['s3:PutObject'])]);
  const copy = (s3: S3Client) =>
    s3.send(
      new CopyObjectCommand({
        Bucket: target,
        Key: 'copied.txt',
        CopySource: `${source}/${SEEDED_KEY}`,
      }),
    );
  expect(await outcome(copy(await freshS3(member)))).toBe('404 NoSuchBucket');

  await owner.setStatements(source, [
    ownersStatement(ownerId),
    allow([memberId], ['s3:GetObject']),
  ]);
  expect(await outcome(copy(await freshS3(member)))).toBe('ok');
});

test('A8. multipart parts listing and abort are granted on their own', async () => {
  const bucket = await bucketWith([allow([memberId], ['s3:PutObject'])]);
  const writeOnly = await freshS3(member);
  const { UploadId } = await writeOnly.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: 'multi.bin' }),
  );
  const part = { Bucket: bucket, Key: 'multi.bin', UploadId };
  expect([
    await outcome(writeOnly.send(new UploadPartCommand({ ...part, PartNumber: 1, Body: PAYLOAD }))),
    await outcome(writeOnly.send(new ListPartsCommand(part))),
    await outcome(writeOnly.send(new AbortMultipartUploadCommand(part))),
  ]).toEqual(['ok', '403 AccessDenied', '403 AccessDenied']);

  await owner.setStatements(bucket, [
    ownersStatement(ownerId),
    allow([memberId], ['s3:PutObject', 's3:ListMultipartUploadParts', 's3:AbortMultipartUpload']),
  ]);
  const full = await freshS3(member);
  expect([
    await outcome(full.send(new ListPartsCommand(part))),
    await outcome(full.send(new AbortMultipartUploadCommand(part))),
  ]).toEqual(['ok', 'ok']);
});

test('A9. versions are read and deleted under their own actions', async () => {
  const bucket = await bucketWith(
    [allow([memberId], ['s3:GetObject', 's3:DeleteObject', 's3:ListBucket'])],
    { versioning: true },
  );
  const { VersionId } = await ownerS3.send(
    new PutObjectCommand({ Bucket: bucket, Key: SEEDED_KEY, Body: PAYLOAD }),
  );
  const s3 = await freshS3(member);
  expect([
    await outcome(get(s3, bucket)),
    await outcome(get(s3, bucket, VersionId)),
    await outcome(s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: SEEDED_KEY, VersionId }))),
    await outcome(s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))),
  ]).toEqual(['ok', '403 AccessDenied', '403 AccessDenied', 'ok']);
});

test('A10. reading bucket configuration counts as listing', async () => {
  const bucket = await bucketWith([allow([memberId], ['s3:GetObject'])]);
  expect(
    await outcome((await freshS3(member)).send(new GetBucketVersioningCommand({ Bucket: bucket }))),
  ).toBe('403 AccessDenied');
});

test.describe('C. policy writes', () => {
  let bucket: string;
  test.beforeAll(async () => {
    bucket = await bucketWith([]);
  });

  test('C1. of two writes under one etag, exactly one lands', async () => {
    const { etag } = await owner.readPolicy(bucket);
    const write = (sid: string) =>
      owner.putPolicy(bucket, {
        policy: {
          statement: [ownersStatement(ownerId), allow([memberId], ['s3:ListBucket'], sid)],
        },
        etag,
      });
    const statuses = (await Promise.all([write('first'), write('second')])).map((r) => r.status());
    expect(statuses.sort((a, b) => a - b)).toEqual([200, 409]);
  });

  test('C2. a delete under a stale etag loses', async () => {
    const { etag: stale } = await owner.readPolicy(bucket);
    await owner.setStatements(bucket, [ownersStatement(ownerId)]);
    const res = await owner.deletePolicy(bucket, stale);
    expect([res.status(), (await res.json()).code]).toEqual([409, 'POLICY_CONFLICT']);
    expect((await owner.getPolicy(bucket)).status()).toBe(200);
  });

  test('C3. the schema is strict about fields and lengths', async () => {
    const { etag } = await owner.readPolicy(bucket);
    const statuses = [];
    for (const statement of [
      { ...allow([memberId], ['s3:GetObject']), resource: 'arn:aws:s3:::x' },
      allow([memberId], ['s3:GetObject'], 'x'.repeat(129)),
      allow(['x'.repeat(256)], ['s3:GetObject']),
    ]) {
      const res = await owner.putPolicy(bucket, {
        policy: { statement: [ownersStatement(ownerId), statement] },
        etag,
      });
      statuses.push(res.status());
    }
    expect(statuses).toEqual([400, 400, 400]);
  });
});
