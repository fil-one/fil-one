import { test, expect, type Page } from '@playwright/test';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  allow,
  buildBucketPolicy,
  buildCreatorPolicy,
  grantAllToOwner,
  createS3ClientWithNewKey,
  deleteObject,
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
  STORAGE_STATE,
  type PolicyUser,
} from './policy.util.ts';

// The same bucket as each role sees it: the Owner and the Admin are unscoped
// in the console, and anyone's own key reaches a bucket only through a
// statement naming them. A role still caps what the console lets a user do,
// whatever the policy grants them.

test.describe.configure({ mode: 'serial' });

const ROLES: PolicyUser[] = ['owner', 'admin', 'member', 'readonly'];
const userIdByRole = Object.fromEntries(ROLES.map((r) => [r, getCredentials(r).userId])) as Record<
  PolicyUser,
  string
>;

let orgId: string;
let apiByRole: Record<PolicyUser, ConsoleApi>;
const buckets: string[] = [];
const createdKeys: { api: ConsoleApi; id: string }[] = [];

async function createTrackedBucket(): Promise<string> {
  const bucket = generateBucketName('role');
  await apiByRole.owner.createBucket(bucket);
  buckets.push(bucket);
  return bucket;
}

test.beforeAll(async () => {
  orgId = await resolvePersonalOrgId(userIdByRole.owner);
  apiByRole = Object.fromEntries(
    await Promise.all(ROLES.map(async (r) => [r, await ConsoleApi.open(r, orgId)])),
  );
});

test.afterAll(async () => {
  // Every bucket and key the file made goes one at a time, each several calls.
  test.setTimeout(180_000);
  await runCleanup([
    ...buckets.map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => emptyAndDeleteBucket(apiByRole.owner, userIdByRole.owner, bucket),
    })),
    ...createdKeys.map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
  await Promise.all(ROLES.map((r) => apiByRole[r].dispose()));
});

test('R1. only the owner and the admin may read or write a policy', async () => {
  const bucket = await createTrackedBucket();
  const { etag, policy } = await apiByRole.owner.readPolicy(bucket);
  const statuses = [];
  for (const role of ROLES) {
    statuses.push([
      role,
      (await apiByRole[role].fetchPolicyResponse(bucket)).status(),
      (
        await apiByRole[role].putPolicy(bucket, {
          policy,
          etag: (await apiByRole.owner.readPolicy(bucket)).etag,
        })
      ).status(),
    ]);
  }
  expect(statuses).toEqual([
    ['owner', 200, 204],
    ['admin', 200, 204],
    ['member', 403, 403],
    ['readonly', 403, 403],
  ]);
  expect(etag).toEqual(expect.any(String));
});

test('R2. every role but readonly may create a bucket and mint a key', async () => {
  const outcomes = [];
  for (const role of ROLES) {
    const bucket = generateBucketName(`r2-${role}`);
    const created = await apiByRole[role].send('POST', '/buckets', {
      bucketName: bucket,
      region: REGION,
    });
    if (created.status() === 201) buckets.push(bucket);
    const key = await apiByRole[role].send('POST', '/access-keys', {
      keyName: `r2-${role}`,
      region: REGION,
    });
    if (key.status() === 201) createdKeys.push({ api: apiByRole[role], id: (await key.json()).id });
    outcomes.push([role, created.status(), key.status()]);
  }
  expect(outcomes).toEqual([
    ['owner', 201, 201],
    ['admin', 201, 201],
    ['member', 201, 201],
    ['readonly', 403, 403],
  ]);
});

test('R3. a bucket the admin creates names only the admin', async () => {
  const bucket = generateBucketName('r3');
  await apiByRole.admin.createBucket(bucket);
  buckets.push(bucket);
  expect(toCanonicalPolicy((await apiByRole.owner.readPolicy(bucket)).policy)).toEqual(
    toCanonicalPolicy(buildCreatorPolicy(bucket, userIdByRole.admin)),
  );
});

test("R4. on a new bucket the creator's key reaches it and nobody else's", async () => {
  const bucket = await createTrackedBucket();
  const results = [];
  for (const role of ['owner', 'admin', 'member'] as const) {
    const s3 = await createS3ClientWithNewKey(apiByRole[role], createdKeys);
    results.push([
      role,
      await getS3Outcome(putObject(s3, bucket, `${role}.txt`)),
      await getS3Outcome(listObjects(s3, bucket)),
      await getS3Outcome(deleteObject(s3, bucket, `${role}.txt`)),
    ]);
  }
  expect(results).toEqual([
    ['owner', 'ok', 'ok', 'ok'],
    ['admin', '404 NoSuchBucket', '404 NoSuchBucket', '404 NoSuchBucket'],
    ['member', '404 NoSuchBucket', '404 NoSuchBucket', '404 NoSuchBucket'],
  ]);
});

test('R5. the console lists a bucket to the roles a statement grants access', async () => {
  const bucket = await createTrackedBucket();
  await apiByRole.owner.replaceStatements(bucket, [
    grantAllToOwner(userIdByRole.owner),
    allow([userIdByRole.member], ['s3:ListBucket']),
  ]);
  const listed = [];
  for (const role of ROLES) {
    listed.push([role, (await apiByRole[role].listBucketNames()).includes(bucket)]);
  }
  expect(listed).toEqual([
    ['owner', true],
    ['admin', true],
    ['member', true],
    ['readonly', false],
  ]);
});

test('R6. readonly reads what a policy grants and no more than the role allows', async () => {
  const bucket = await createTrackedBucket();
  await putObject(await createS3ClientWithNewKey(apiByRole.owner, createdKeys), bucket, SEEDED_KEY);
  // Even a write grant does not let readonly write: the role caps the console.
  await apiByRole.owner.replaceStatements(bucket, [
    grantAllToOwner(userIdByRole.owner),
    allow([userIdByRole.readonly], ['s3:ListBucket', 's3:GetObject', 's3:PutObject']),
  ]);

  const presign = (op: object) =>
    apiByRole.readonly.send('POST', `/presign?region=${REGION}`, [op]);
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
  expect((await apiByRole.readonly.listBucketNames()).includes(bucket)).toBe(true);
});

test.describe('the Policy tab', { tag: '@browser' }, () => {
  let bucket: string;
  test.beforeAll(async () => {
    bucket = await createTrackedBucket();
    await apiByRole.owner.replaceStatements(bucket, [
      grantAllToOwner(userIdByRole.owner),
      allow([userIdByRole.member, userIdByRole.readonly], ['s3:ListBucket', 's3:GetObject']),
    ]);
  });

  // The tab waits on the caller's permissions, which /api/me carries, so the
  // count is read only once that has answered.
  const expectPolicyTabVisibility = async (page: Page, shown: boolean) => {
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
        await expectPolicyTabVisibility(page, shown);
      });
    });
  }
});

test("R8. the first policy is the server's own, whatever a creator sends", async () => {
  // The create request carries no policy; the server names the creator and
  // sends that on the create itself, so a creator who asks for more gets the
  // default and nothing else.
  const results = [];
  const expected = [];
  for (const role of ['admin', 'member'] as const) {
    const bucket = generateBucketName(`r8-${role}`);
    const created = await apiByRole[role].send('POST', '/buckets', {
      bucketName: bucket,
      region: REGION,
      policy: buildBucketPolicy(bucket, [allow('*', ['s3:*'], 'mine')]),
    });
    if (created.status() === 201) buckets.push(bucket);
    results.push([
      role,
      created.status(),
      toCanonicalPolicy((await apiByRole.owner.readPolicy(bucket)).policy),
    ]);
    expected.push([role, 201, toCanonicalPolicy(buildCreatorPolicy(bucket, userIdByRole[role]))]);
  }
  expect(results).toEqual(expected);
});
