import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { CreateAccessKeyResponse } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  REGION,
  SEEDED_KEY,
  STORAGE_STATE,
  credentials,
  deny,
  listObjects,
  outcome,
  putObject,
  removeBucket,
  rosterPolicy,
  s3For,
  uniqueBucketName,
  type PolicyUser,
} from './policy.util.ts';

// A service key on an `iam` region: its own permissions and bucket list, and
// no bucket policy. Only an Owner or an Admin may mint one, and the creator cap
// and the bucket scope bound it as they do on a scoped-key region.

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

const serviceKeyBody = (scope: string[]) => ({
  keyName: `policy-e2e-svc-${randomUUID().slice(0, 8)}`,
  region: REGION,
  permissions: ['read', 'write', 'list', 'delete'],
  bucketScope: 'specific',
  buckets: scope,
  expiresAt: null,
});

async function mintServiceKey(user: PolicyUser, scope: string[]): Promise<CreateAccessKeyResponse> {
  const res = await api[user].send('POST', '/access-keys', serviceKeyBody(scope));
  expect(res.status(), await res.text()).toBe(201);
  const key = (await res.json()) as CreateAccessKeyResponse;
  minted.push({ api: api[user], id: key.id });
  return key;
}

async function newBucket(): Promise<string> {
  const bucket = uniqueBucketName('svc');
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

test('S1. an owner service key reaches its bucket under any policy, and no other', async () => {
  const inScope = await newBucket();
  const outOfScope = await newBucket();
  // A deny naming everyone locks every principal out. A service key is not one.
  await api.owner.setStatements(inScope, [
    ...rosterPolicy(ids.owner, ids.admin).statement,
    deny('*', ['s3:*']),
  ]);

  const key = await mintServiceKey('owner', [inScope]);
  expect(key).not.toHaveProperty('principalId');

  const s3 = s3For(key);
  expect(await outcome(putObject(s3, inScope, SEEDED_KEY))).toBe('ok');
  expect(await outcome(listObjects(s3, inScope))).toBe('ok');
  // Outside its list the key is refused.
  expect(await outcome(listObjects(s3, outOfScope))).toBe('403 AccessDenied');
});

test('S2. an admin may mint one; a member and a readonly user may not', async () => {
  const bucket = await newBucket();
  await mintServiceKey('admin', [bucket]);

  const member = await api.member.send('POST', '/access-keys', serviceKeyBody([bucket]));
  expect([member.status(), ((await member.json()) as { message: string }).message]).toEqual([
    403,
    'Only an Owner or an Admin can create a service key on this region.',
  ]);
  // A readonly user cannot mint a key of any kind; the chain refuses first.
  const readonly = await api.readonly.send('POST', '/access-keys', serviceKeyBody([bucket]));
  expect(readonly.status()).toBe(403);
});

test.describe('the key form', () => {
  test.describe('as the owner', () => {
    test.use({ storageState: STORAGE_STATE.owner });

    test('S3. offers a service key, and asks for its permissions and buckets', async ({ page }) => {
      await page.goto('/api-keys/create');
      await page.locator('#key-name').fill(`policy-e2e-svc-ui-${randomUUID().slice(0, 8)}`);
      await page.locator('#key-region').selectOption(REGION);
      await expect(page.getByTestId('access-key-follows-policy')).toBeVisible();

      await page.getByTestId('access-key-kind-service').click();
      await expect(page.getByTestId('access-key-permissions')).toBeVisible();
      await expect(page.getByTestId('access-key-follows-policy')).toHaveCount(0);

      const created = page.waitForResponse(
        (r) => r.url().endsWith('/api/access-keys') && r.request().method() === 'POST',
      );
      await page.locator('#create-api-key-submit-button').click();
      const key = (await (await created).json()) as CreateAccessKeyResponse;
      minted.push({ api: api.owner, id: key.id });
      expect(key).not.toHaveProperty('principalId');

      await page.locator('#save-credentials-done-button').click();
      const row = page.locator(
        `[data-testid="access-key-row"][data-access-key-id="${key.accessKeyId}"]`,
      );
      await expect(row.getByTestId('permission-badge-bucket-info')).toBeVisible();
      await expect(row.getByTestId('permission-badge-follows-policy')).toHaveCount(0);
    });
  });

  test.describe('as the member', () => {
    test.use({ storageState: STORAGE_STATE.member });

    // The tab's active org lives in sessionStorage (lib/active-org.ts); without
    // it the Member's tab opens their personal org, where they are an Owner.
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((id) => sessionStorage.setItem('filone:activeOrgId', id), orgId);
    });

    test('S4. offers a member no choice: their key follows the policies', async ({ page }) => {
      await page.goto('/api-keys/create');
      await page.locator('#key-name').fill('policy-e2e-svc-member');
      await page.locator('#key-region').selectOption(REGION);
      await expect(page.getByTestId('access-key-follows-policy')).toBeVisible();
      await expect(page.getByTestId('access-key-kind-service')).toHaveCount(0);
    });
  });
});
