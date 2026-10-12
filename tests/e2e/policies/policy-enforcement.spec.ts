import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
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
  getCredentials,
  deleteObject,
  deny,
  listObjects,
  getS3Outcome,
  buildOwnersStatement,
  putObject,
  emptyAndDeleteBucket,
  createS3ClientWithNewKey,
  generateBucketName,
  toCanonicalPolicy,
} from './policy.util.ts';

// Which S3 operations each action admits, read at the gateway. Several actions
// share a storage command (`s3:GetObject` and `s3:ListBucket` both retrieve,
// `s3:PutObject` carries the right to remove), so only the gateway's cached
// action set tells them apart; these cases pin that it does.
//
// Every case names its statements on a fresh bucket and checks them with a key
// created after the write. Only the cached-key test polls, because a widened
// grant arriving at a key the gateway has cached is what it checks.

const ownerId = getCredentials('owner').userId;
const memberId = getCredentials('member').userId;

let owner: ConsoleApi;
let admin: ConsoleApi;
let member: ConsoleApi;
let ownerS3: S3Client;
const buckets: string[] = [];
const createdKeys: { api: ConsoleApi; id: string }[] = [];

/** A bucket holding SEEDED_KEY whose policy is the owners plus `statements`. */
async function createBucketWithStatements(
  statements: PolicyStatement[],
  { versioning = false, lock = false } = {},
): Promise<string> {
  const bucket = generateBucketName('enf');
  await owner.createBucket(bucket, { versioning, lock });
  buckets.push(bucket);
  await putObject(ownerS3, bucket, SEEDED_KEY);
  await owner.replaceStatements(bucket, [buildOwnersStatement(ownerId), ...statements]);
  return bucket;
}

const getSeededObject = (s3: S3Client, bucket: string, VersionId?: string) =>
  s3.send(new GetObjectCommand({ Bucket: bucket, Key: SEEDED_KEY, VersionId }));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  admin = await ConsoleApi.open('admin', orgId);
  member = await ConsoleApi.open('member', orgId);
  ownerS3 = await createS3ClientWithNewKey(owner, createdKeys);
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
  ]);
  await Promise.all([owner.dispose(), admin.dispose(), member.dispose()]);
});

test('A1. a write grant does not carry deletion', async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:PutObject'])]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(putObject(s3, bucket, 'member.txt')),
    await getS3Outcome(deleteObject(s3, bucket, SEEDED_KEY)),
  ]).toEqual(['ok', '403 AccessDenied']);
});

test('A2. a list grant does not carry reading', async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:ListBucket'])]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(listObjects(s3, bucket)),
    await getS3Outcome(getSeededObject(s3, bucket)),
  ]).toEqual(['ok', '403 AccessDenied']);
});

test('A3. a deny carves one action out of s3:*', async () => {
  const bucket = await createBucketWithStatements([
    allow([memberId], ['s3:*']),
    deny([memberId], ['s3:DeleteObject']),
  ]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(putObject(s3, bucket, 'member.txt')),
    await getS3Outcome(getSeededObject(s3, bucket)),
    await getS3Outcome(deleteObject(s3, bucket, SEEDED_KEY)),
  ]).toEqual(['ok', 'ok', '403 AccessDenied']);
});

test('A4. a deny naming one member leaves an allow for everyone to the rest', async () => {
  const bucket = await createBucketWithStatements([
    allow('*', ['s3:ListBucket', 's3:GetObject']),
    deny([memberId], ['s3:ListBucket']),
  ]);
  const memberS3 = await createS3ClientWithNewKey(member, createdKeys);
  const adminS3 = await createS3ClientWithNewKey(admin, createdKeys);
  expect([
    await getS3Outcome(listObjects(memberS3, bucket)),
    await getS3Outcome(getSeededObject(memberS3, bucket)),
    await getS3Outcome(listObjects(adminS3, bucket)),
  ]).toEqual(['403 AccessDenied', 'ok', 'ok']);
});

test('A5. actions granted across statements add up', async () => {
  const bucket = await createBucketWithStatements([
    allow([memberId], ['s3:ListBucket'], 'list'),
    allow([memberId], ['s3:GetObject'], 'read'),
  ]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(listObjects(s3, bucket)),
    await getS3Outcome(getSeededObject(s3, bucket)),
    await getS3Outcome(putObject(s3, bucket, 'member.txt')),
  ]).toEqual(['ok', 'ok', '403 AccessDenied']);
});

test('A6. a widened grant applies to a key the gateway has cached', async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:ListBucket'])]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect(await getS3Outcome(listObjects(s3, bucket))).toBe('ok');
  expect(await getS3Outcome(putObject(s3, bucket, 'member.txt'))).toBe('403 AccessDenied');

  await owner.replaceStatements(bucket, [
    buildOwnersStatement(ownerId),
    allow([memberId], ['s3:ListBucket', 's3:PutObject']),
  ]);
  // The one wait here: the widened grant arriving at the gateway's cache is the subject.
  await expect
    .poll(() => getS3Outcome(putObject(s3, bucket, 'member.txt')), { timeout: 30_000 })
    .toBe('ok');
});

test('A7. a copy needs a read on its source bucket', async () => {
  const source = await createBucketWithStatements([]);
  const target = await createBucketWithStatements([allow([memberId], ['s3:PutObject'])]);
  const copy = (s3: S3Client) =>
    s3.send(
      new CopyObjectCommand({
        Bucket: target,
        Key: 'copied.txt',
        CopySource: `${source}/${SEEDED_KEY}`,
      }),
    );
  expect(await getS3Outcome(copy(await createS3ClientWithNewKey(member, createdKeys)))).toBe(
    '404 NoSuchBucket',
  );

  await owner.replaceStatements(source, [
    buildOwnersStatement(ownerId),
    allow([memberId], ['s3:GetObject']),
  ]);
  expect(await getS3Outcome(copy(await createS3ClientWithNewKey(member, createdKeys)))).toBe('ok');
});

test('A8. multipart parts listing and abort are granted on their own', async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:PutObject'])]);
  const writeOnly = await createS3ClientWithNewKey(member, createdKeys);
  const { UploadId } = await writeOnly.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: 'multi.bin' }),
  );
  const part = { Bucket: bucket, Key: 'multi.bin', UploadId };
  expect([
    await getS3Outcome(
      writeOnly.send(new UploadPartCommand({ ...part, PartNumber: 1, Body: PAYLOAD })),
    ),
    await getS3Outcome(writeOnly.send(new ListPartsCommand(part))),
    await getS3Outcome(writeOnly.send(new AbortMultipartUploadCommand(part))),
  ]).toEqual(['ok', '403 AccessDenied', '403 AccessDenied']);

  await owner.replaceStatements(bucket, [
    buildOwnersStatement(ownerId),
    allow([memberId], ['s3:PutObject', 's3:ListMultipartUploadParts', 's3:AbortMultipartUpload']),
  ]);
  const full = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(full.send(new ListPartsCommand(part))),
    await getS3Outcome(full.send(new AbortMultipartUploadCommand(part))),
  ]).toEqual(['ok', 'ok']);
});

test('A9. versions are read and deleted under their own actions', async () => {
  const bucket = await createBucketWithStatements(
    [allow([memberId], ['s3:GetObject', 's3:DeleteObject', 's3:ListBucket'])],
    { versioning: true },
  );
  const { VersionId } = await ownerS3.send(
    new PutObjectCommand({ Bucket: bucket, Key: SEEDED_KEY, Body: PAYLOAD }),
  );
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(getSeededObject(s3, bucket)),
    await getS3Outcome(getSeededObject(s3, bucket, VersionId)),
    await getS3Outcome(
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: SEEDED_KEY, VersionId })),
    ),
    await getS3Outcome(s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))),
  ]).toEqual(['ok', '403 AccessDenied', '403 AccessDenied', 'ok']);
});

test('A10. GetBucketVersioning is refused without s3:ListBucket', async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:GetObject'])]);
  expect(
    await getS3Outcome(
      (await createS3ClientWithNewKey(member, createdKeys)).send(
        new GetBucketVersioningCommand({ Bucket: bucket }),
      ),
    ),
  ).toBe('403 AccessDenied');
});

test('A11. a write or read grant does not carry retention or legal holds', async () => {
  const bucket = await createBucketWithStatements(
    [allow([memberId], ['s3:PutObject', 's3:GetObject'])],
    {
      lock: true,
    },
  );
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  const object = { Bucket: bucket, Key: SEEDED_KEY };
  try {
    expect([
      // A date in the past: were the action permitted, the gateway would refuse
      // the date instead, so no retention is ever applied.
      await getS3Outcome(
        s3.send(
          new PutObjectRetentionCommand({
            ...object,
            Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date('2000-01-01') },
          }),
        ),
      ),
      await getS3Outcome(
        s3.send(new PutObjectLegalHoldCommand({ ...object, LegalHold: { Status: 'ON' } })),
      ),
      await getS3Outcome(s3.send(new GetObjectRetentionCommand(object))),
    ]).toEqual(['403 AccessDenied', '403 AccessDenied', '403 AccessDenied']);
  } finally {
    // Were the hold applied, it would keep teardown from deleting the object.
    await ownerS3.send(new PutObjectLegalHoldCommand({ ...object, LegalHold: { Status: 'OFF' } }));
  }
});

test('A12. listing versions is granted on its own', async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:ListBucket'])], {
    versioning: true,
  });
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(listObjects(s3, bucket)),
    await getS3Outcome(s3.send(new ListObjectVersionsCommand({ Bucket: bucket }))),
  ]).toEqual(['ok', '403 AccessDenied']);
});

test.describe('C. policy writes', () => {
  let bucket: string;
  test.beforeAll(async () => {
    bucket = await createBucketWithStatements([]);
  });

  test('C1. of two writes under one If-Match, exactly one succeeds and the other gets 412', async () => {
    const { etag } = await owner.readPolicy(bucket);
    const write = (sid: string) =>
      owner.putPolicy(bucket, {
        policy: {
          Statement: [buildOwnersStatement(ownerId), allow([memberId], ['s3:ListBucket'], sid)],
        },
        etag,
      });
    const statuses = (await Promise.all([write('first'), write('second')])).map((r) => r.status());
    expect(statuses.sort((a, b) => a - b)).toEqual([204, 412]);
  });

  test('C2. a delete under a stale If-Match is refused', async () => {
    const { etag: stale } = await owner.readPolicy(bucket);
    await owner.replaceStatements(bucket, [buildOwnersStatement(ownerId)]);
    const before = await owner.readPolicy(bucket);
    const res = await owner.deletePolicy(bucket, stale);
    expect([res.status(), (await res.json()).code]).toEqual([412, 'POLICY_CONFLICT']);
    expect(await owner.readPolicy(bucket)).toEqual(before);
  });

  for (const [title, statement] of [
    [
      'C3a. a statement with a field the schema does not know is refused',
      { ...allow([memberId], ['s3:GetObject']), resource: 'arn:aws:s3:::x' },
    ],
    [
      'C3b. a Sid longer than 128 characters is refused',
      allow([memberId], ['s3:GetObject'], 'x'.repeat(129)),
    ],
    [
      'C3c. a principal id longer than 255 characters is refused',
      allow(['x'.repeat(256)], ['s3:GetObject']),
    ],
    ['C3d. a principal id that is not a UUID is refused', allow(['not-a-uuid'], ['s3:GetObject'])],
  ] as const) {
    test(title, async () => {
      const { etag } = await owner.readPolicy(bucket);
      const res = await owner.putPolicy(bucket, {
        policy: { Statement: [buildOwnersStatement(ownerId), statement] },
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

  test('C4. a member named twice in a statement is stored once', async () => {
    await owner.replaceStatements(bucket, [
      buildOwnersStatement(ownerId),
      allow([memberId, ownerId, memberId], ['s3:ListBucket'], 'repeat'),
    ]);
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
      toCanonicalPolicy({
        Statement: [
          buildOwnersStatement(ownerId),
          allow([memberId, ownerId], ['s3:ListBucket'], 'repeat'),
        ],
      }),
    );
  });
});
