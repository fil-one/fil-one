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
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  allow,
  buildBucketPolicy,
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
  SEEDED_KEY,
  type UnboundStatement,
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
  statements: UnboundStatement[],
  { versioning = false, lock = false } = {},
): Promise<string> {
  const bucket = generateBucketName('enf');
  await owner.createBucket(bucket, { versioning, lock });
  buckets.push(bucket);
  await putObject(ownerS3, bucket, SEEDED_KEY);
  await owner.replaceStatements(bucket, [grantAllToOwner(ownerId), ...statements]);
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

test('a write grant does not carry deletion', { tag: '@api' }, async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:PutObject'])]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(putObject(s3, bucket, 'member.txt')),
    await getS3Outcome(deleteObject(s3, bucket, SEEDED_KEY)),
  ]).toEqual(['ok', '403 AccessDenied']);
});

test('a list grant does not carry reading', { tag: '@api' }, async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:ListBucket'])]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(listObjects(s3, bucket)),
    await getS3Outcome(getSeededObject(s3, bucket)),
  ]).toEqual(['ok', '403 AccessDenied']);
});

test('a deny carves one action out of s3:*', { tag: '@api' }, async () => {
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

test(
  'a deny naming one member leaves an allow for everyone to the rest',
  { tag: '@api' },
  async () => {
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
  },
);

test('actions granted across statements add up', { tag: '@api' }, async () => {
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

test('a widened grant applies to a key the gateway has cached', { tag: '@api' }, async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:ListBucket'])]);
  const s3 = await createS3ClientWithNewKey(member, createdKeys);
  expect(await getS3Outcome(listObjects(s3, bucket))).toBe('ok');
  expect(await getS3Outcome(putObject(s3, bucket, 'member.txt'))).toBe('403 AccessDenied');

  await owner.replaceStatements(bucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:ListBucket', 's3:PutObject']),
  ]);
  // The one wait here: the widened grant arriving at the gateway's cache is the subject.
  await expect
    .poll(() => getS3Outcome(putObject(s3, bucket, 'member.txt')), { timeout: 30_000 })
    .toBe('ok');
});

test('a copy needs a read on its source bucket', { tag: '@api' }, async () => {
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
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:GetObject']),
  ]);
  expect(await getS3Outcome(copy(await createS3ClientWithNewKey(member, createdKeys)))).toBe('ok');
});

test('multipart parts listing and abort are granted on their own', { tag: '@api' }, async () => {
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
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:PutObject', 's3:ListMultipartUploadParts', 's3:AbortMultipartUpload']),
  ]);
  const full = await createS3ClientWithNewKey(member, createdKeys);
  expect([
    await getS3Outcome(full.send(new ListPartsCommand(part))),
    await getS3Outcome(full.send(new AbortMultipartUploadCommand(part))),
  ]).toEqual(['ok', 'ok']);
});

test('versions are read and deleted under their own actions', { tag: '@api' }, async () => {
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

test('GetBucketVersioning is refused without s3:ListBucket', { tag: '@api' }, async () => {
  const bucket = await createBucketWithStatements([allow([memberId], ['s3:GetObject'])]);
  expect(
    await getS3Outcome(
      (await createS3ClientWithNewKey(member, createdKeys)).send(
        new GetBucketVersioningCommand({ Bucket: bucket }),
      ),
    ),
  ).toBe('403 AccessDenied');
});

test('a write or read grant does not carry retention or legal holds', { tag: '@api' }, async () => {
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

test('listing versions is granted on its own', { tag: '@api' }, async () => {
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

  test(
    'two concurrent writes both succeed and the stored policy is one of the two documents',
    { tag: '@api' },
    async () => {
      const buildWrite = (sid: string) =>
        buildBucketPolicy(bucket, [
          grantAllToOwner(ownerId),
          allow([memberId], ['s3:ListBucket'], sid),
        ]);
      const [first, second] = [buildWrite('first'), buildWrite('second')];
      const statuses = (
        await Promise.all([owner.putPolicy(bucket, first), owner.putPolicy(bucket, second)])
      ).map((r) => r.status());
      expect(statuses).toEqual([204, 204]);
      expect([toCanonicalPolicy(first), toCanonicalPolicy(second)]).toContainEqual(
        toCanonicalPolicy((await owner.readPolicy(bucket)).policy),
      );
    },
  );

  for (const [title, statement] of [
    [
      'a statement with a field the schema does not know is refused',
      { ...allow([memberId], ['s3:GetObject']), resource: 'arn:aws:s3:::x' } as UnboundStatement,
    ],
    [
      'a Sid longer than 128 characters is refused',
      allow([memberId], ['s3:GetObject'], 'x'.repeat(129)),
    ],
    [
      'a principal id longer than 255 characters is refused',
      allow(['x'.repeat(256)], ['s3:GetObject']),
    ],
    ['a principal id that is not a UUID is refused', allow(['not-a-uuid'], ['s3:GetObject'])],
  ] as const) {
    test(title, { tag: '@api' }, async () => {
      const res = await owner.putPolicy(
        bucket,
        buildBucketPolicy(bucket, [grantAllToOwner(ownerId), statement]),
      );
      const body = await res.text();
      // A validation refusal carries a message and no code.
      expect({ status: res.status(), code: JSON.parse(body).code }, body).toEqual({
        status: 400,
        code: undefined,
      });
    });
  }

  test('a member named twice in a statement is stored once', { tag: '@api' }, async () => {
    await owner.replaceStatements(bucket, [
      grantAllToOwner(ownerId),
      allow([memberId, ownerId, memberId], ['s3:ListBucket'], 'repeat'),
    ]);
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
      toCanonicalPolicy(
        buildBucketPolicy(bucket, [
          grantAllToOwner(ownerId),
          allow([memberId, ownerId], ['s3:ListBucket'], 'repeat'),
        ]),
      ),
    );
  });
});
