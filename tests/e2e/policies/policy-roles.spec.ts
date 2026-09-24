import { test, expect, type Page } from '@playwright/test';
import { ROSTER_ADMIN_ACTIONS } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  PAYLOAD,
  REGION,
  SEEDED_KEY,
  STORAGE_STATE,
  allow,
  credentials,
  deleteObject,
  listObjects,
  outcome,
  putObject,
  removeBucket,
  rosterPolicy,
  s3For,
  uniqueBucketName,
  type PolicyUser,
} from './policy.util.ts';

// The same bucket as each role sees it: the Owner and the Admin are unscoped
// and reach it through the roster statements, the Member and the ReadOnly user
// only through a statement naming them. A role still caps what the console lets
// a user do, whatever the policy grants them.

test.describe.configure({ mode: 'serial' });

const ROLES: PolicyUser[] = ['owner', 'admin', 'member', 'readonly'];
const ids = Object.fromEntries(ROLES.map((r) => [r, credentials(r).userId])) as Record<
  PolicyUser,
  string
>;

let orgId: string;
let api: Record<PolicyUser, ConsoleApi>;
const buckets: string[] = [];
const minted: { api: ConsoleApi; id: string }[] = [];

async function newBucket(): Promise<string> {
  const bucket = uniqueBucketName('role');
  await api.owner.createBucket(bucket);
  buckets.push(bucket);
  return bucket;
}

test.beforeAll(async () => {
  orgId = await resolvePersonalOrgId(ids.owner);
  api = Object.fromEntries(
    await Promise.all(ROLES.map(async (r) => [r, await ConsoleApi.open(r, orgId)])),
  );
});

test.afterAll(async () => {
  // Every bucket and key the file made goes one at a time, each several calls.
  test.setTimeout(180_000);
  await runCleanup([
    ...buckets.map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => removeBucket(api.owner, ids.owner, bucket),
    })),
    ...minted.map(({ api: a, id }) => ({ label: `key ${id}`, run: () => a.deleteKey(id) })),
  ]);
  await Promise.all(ROLES.map((r) => api[r].dispose()));
});

test('R1. only the owner and the admin may read or write a policy', async () => {
  const bucket = await newBucket();
  const { etag, policy } = await api.owner.readPolicy(bucket);
  const statuses = [];
  for (const role of ROLES) {
    statuses.push([
      role,
      (await api[role].getPolicy(bucket)).status(),
      (
        await api[role].putPolicy(bucket, {
          policy,
          etag: (await api.owner.readPolicy(bucket)).etag,
        })
      ).status(),
    ]);
  }
  expect(statuses).toEqual([
    ['owner', 200, 200],
    ['admin', 200, 200],
    ['member', 403, 403],
    ['readonly', 403, 403],
  ]);
  expect(etag).toEqual(expect.any(String));
});

test('R2. every role but readonly may create a bucket and mint a key', async () => {
  const outcomes = [];
  for (const role of ROLES) {
    const bucket = uniqueBucketName(`r2-${role}`);
    const created = await api[role].send('POST', '/buckets', {
      bucketName: bucket,
      region: REGION,
    });
    if (created.status() === 201) buckets.push(bucket);
    const key = await api[role].send('POST', '/access-keys', {
      keyName: `r2-${role}`,
      region: REGION,
    });
    if (key.status() === 201) minted.push({ api: api[role], id: (await key.json()).id });
    outcomes.push([role, created.status(), key.status()]);
  }
  expect(outcomes).toEqual([
    ['owner', 201, 201],
    ['admin', 201, 201],
    ['member', 201, 201],
    ['readonly', 403, 403],
  ]);
});

test('R3. a bucket the admin creates carries the roster and no creator statement', async () => {
  const bucket = uniqueBucketName('r3');
  await api.admin.createBucket(bucket);
  buckets.push(bucket);
  expect((await api.owner.readPolicy(bucket)).policy).toEqual(rosterPolicy(ids.owner, ids.admin));
});

test('R4. on a new bucket the roster reaches the owner and the admin, nobody else', async () => {
  const bucket = await newBucket();
  const results = [];
  for (const role of ['owner', 'admin', 'member'] as const) {
    const key = await api[role].mintKey();
    minted.push({ api: api[role], id: key.id });
    const s3 = s3For(key);
    results.push([
      role,
      await outcome(putObject(s3, bucket, `${role}.txt`)),
      await outcome(listObjects(s3, bucket)),
      await outcome(deleteObject(s3, bucket, `${role}.txt`)),
    ]);
  }
  expect(results).toEqual([
    ['owner', 'ok', 'ok', 'ok'],
    ['admin', 'ok', 'ok', 'ok'],
    ['member', '404 NoSuchBucket', '404 NoSuchBucket', '404 NoSuchBucket'],
  ]);
});

test('R5. the console lists a bucket to the roles that reach it', async () => {
  const bucket = await newBucket();
  await api.owner.setStatements(bucket, [
    ...rosterPolicy(ids.owner, ids.admin).statement,
    allow([ids.member], ['s3:ListBucket']),
  ]);
  const listed = [];
  for (const role of ROLES) {
    listed.push([role, (await api[role].listBucketNames()).includes(bucket)]);
  }
  expect(listed).toEqual([
    ['owner', true],
    ['admin', true],
    ['member', true],
    ['readonly', false],
  ]);
});

test('R6. readonly reads what a policy grants and no more than the role allows', async () => {
  const bucket = await newBucket();
  const ownerKey = await api.owner.mintKey();
  minted.push({ api: api.owner, id: ownerKey.id });
  await putObject(s3For(ownerKey), bucket, SEEDED_KEY);
  // Even a write grant does not let readonly write: the role caps the console.
  await api.owner.setStatements(bucket, [
    ...rosterPolicy(ids.owner, ids.admin).statement,
    allow([ids.readonly], ['s3:ListBucket', 's3:GetObject', 's3:PutObject']),
  ]);

  const presign = (op: object) => api.readonly.send('POST', `/presign?region=${REGION}`, [op]);
  const got = await presign({ op: 'getObject', bucket, key: SEEDED_KEY });
  expect(got.status(), await got.text()).toBe(200);
  const download = await fetch(((await got.json()) as { items: { url: string }[] }).items[0].url);
  expect([download.status, await download.text()]).toEqual([200, PAYLOAD.toString()]);

  const put = await presign({
    op: 'putObject',
    bucket,
    key: 'readonly.txt',
    contentType: 'text/plain',
    fileName: 'readonly.txt',
  });
  expect(put.status()).toBe(403);
  expect((await api.readonly.listBucketNames()).includes(bucket)).toBe(true);
});

test("R8. the first policy is the server's own, whatever a creator sends", async () => {
  // The create request carries no policy; the server builds the roster from the
  // org's membership and sends it on the create itself, so a creator who asks
  // for more gets the default and nothing else.
  const asked = { statement: [allow('*', ['s3:*'], 'mine')] };
  const results = [];
  for (const role of ['admin', 'member'] as const) {
    const bucket = uniqueBucketName(`r8-${role}`);
    const created = await api[role].send('POST', '/buckets', {
      bucketName: bucket,
      region: REGION,
      policy: asked,
    });
    if (created.status() === 201) buckets.push(bucket);
    results.push([role, created.status(), (await api.owner.readPolicy(bucket)).policy]);
  }
  expect(results).toEqual([
    ['admin', 201, rosterPolicy(ids.owner, ids.admin)],
    [
      'member',
      201,
      {
        statement: [
          ...rosterPolicy(ids.owner, ids.admin).statement,
          {
            sid: 'filone-creator',
            effect: 'allow',
            principal: [ids.member],
            action: ROSTER_ADMIN_ACTIONS,
          },
        ],
      },
    ],
  ]);
});

test.describe('the Policy tab', () => {
  let bucket: string;
  test.beforeAll(async () => {
    bucket = await newBucket();
    await api.owner.setStatements(bucket, [
      ...rosterPolicy(ids.owner, ids.admin).statement,
      allow([ids.member, ids.readonly], ['s3:ListBucket', 's3:GetObject']),
    ]);
  });

  // The tab waits on the caller's permissions, which /api/me carries, so the
  // count is read only once that has answered.
  const expectTab = async (page: Page, shown: boolean) => {
    await page.addInitScript((id) => sessionStorage.setItem('filone:activeOrgId', id), orgId);
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me');
    await page.goto(`/buckets/${bucket}?region=${REGION}`);
    await me;
    await expect(page.locator('#bucket-detail-heading')).toHaveText(bucket);
    await expect(page.getByTestId('bucket-policy-tab')).toHaveCount(shown ? 1 : 0);
  };

  for (const [role, shown] of [
    ['owner', true],
    ['admin', true],
    ['member', false],
    ['readonly', false],
  ] as const) {
    test.describe(role, () => {
      test.use({ storageState: STORAGE_STATE[role] });
      test(`R7. the tab is ${shown ? 'shown to' : 'hidden from'} the ${role}`, async ({ page }) => {
        await expectTab(page, shown);
      });
    });
  }
});
