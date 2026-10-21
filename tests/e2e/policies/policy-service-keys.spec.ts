import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { CreateAccessKeyResponse } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  REGION,
  SEEDED_KEY,
  STORAGE_STATE,
  getCredentials,
  deny,
  listObjects,
  getS3Outcome,
  putObject,
  emptyAndDeleteBucket,
  grantAllToOwner,
  createS3Client,
  generateBucketName,
  type PolicyUser,
} from './policy.util.ts';

// A service key on an `iam` region: its own permissions and bucket list, and
// no bucket policy. Only an Owner or an Admin may mint one, and the creator cap
// and the bucket scope bound it as they do on a service-key region.

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

const buildServiceKeyRequest = (scope: string[]) => ({
  keyName: `policy-e2e-svc-${randomUUID().slice(0, 8)}`,
  region: REGION,
  permissions: ['read', 'write', 'list', 'delete'],
  bucketScope: 'specific',
  buckets: scope,
  expiresAt: null,
});

async function createServiceKey(
  user: PolicyUser,
  scope: string[],
): Promise<CreateAccessKeyResponse> {
  const res = await apiByRole[user].send('POST', '/access-keys', buildServiceKeyRequest(scope));
  expect(res.status(), await res.text()).toBe(201);
  const key = (await res.json()) as CreateAccessKeyResponse;
  createdKeys.push({ api: apiByRole[user], id: key.id });
  return key;
}

async function createTrackedBucket(): Promise<string> {
  const bucket = generateBucketName('svc');
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

test(
  'an owner service key accesses its scoped bucket despite a deny-all policy, and no other bucket',
  { tag: '@api' },
  async () => {
    const inScope = await createTrackedBucket();
    const outOfScope = await createTrackedBucket();
    // A deny naming everyone locks every principal out. A service key is not one.
    await apiByRole.owner.replaceStatements(inScope, [
      grantAllToOwner(userIdByRole.owner),
      deny('*', ['s3:*']),
    ]);

    const key = await createServiceKey('owner', [inScope]);
    expect(key).not.toHaveProperty('principalId');

    const s3 = createS3Client(key);
    expect(await getS3Outcome(putObject(s3, inScope, SEEDED_KEY))).toBe('ok');
    expect(await getS3Outcome(listObjects(s3, inScope))).toBe('ok');
    // Outside its list the key is refused.
    expect(await getS3Outcome(listObjects(s3, outOfScope))).toBe('403 AccessDenied');
  },
);

test(
  'an admin may create a service key; a member and a readonly user may not',
  { tag: '@api' },
  async () => {
    const bucket = await createTrackedBucket();
    await createServiceKey('admin', [bucket]);

    const member = await apiByRole.member.send(
      'POST',
      '/access-keys',
      buildServiceKeyRequest([bucket]),
    );
    expect([member.status(), ((await member.json()) as { message: string }).message]).toEqual([
      403,
      'Only an Owner or an Admin can create a service key on this region.',
    ]);
    // A readonly user cannot mint a key of any kind; the chain refuses first.
    const readonly = await apiByRole.readonly.send(
      'POST',
      '/access-keys',
      buildServiceKeyRequest([bucket]),
    );
    expect(readonly.status()).toBe(403);
  },
);

test.describe('the key form', () => {
  test.describe('as the owner', () => {
    test.use({ storageState: STORAGE_STATE.owner });

    test('offers a service key, and asks for its permissions and buckets', async ({ page }) => {
      await page.goto('/api-keys/create');
      await page.locator('#key-name').fill(`policy-e2e-svc-ui-${randomUUID().slice(0, 8)}`);
      await page.locator('#key-region').selectOption(REGION);
      await expect(page.getByTestId('access-key-follows-bucket-policy')).toBeVisible();

      await page.getByTestId('access-key-type-service').click();
      await expect(page.getByTestId('access-key-permissions')).toBeVisible();
      await expect(page.getByTestId('access-key-follows-bucket-policy')).toHaveCount(0);

      const created = page.waitForResponse(
        (r) => r.url().endsWith('/api/access-keys') && r.request().method() === 'POST',
      );
      await page.locator('#create-api-key-submit-button').click();
      const key = (await (await created).json()) as CreateAccessKeyResponse;
      createdKeys.push({ api: apiByRole.owner, id: key.id });
      expect(key).not.toHaveProperty('principalId');

      await page.locator('#save-credentials-done-button').click();
      const row = page.locator(
        `[data-testid="access-key-row"][data-access-key-id="${key.accessKeyId}"]`,
      );
      await expect(row.getByTestId('permission-badge-bucket-info')).toBeVisible();
      await expect(row.getByTestId('permission-badge-follows-bucket-policy')).toHaveCount(0);
    });
  });

  test.describe('as the member', () => {
    test.use({ storageState: STORAGE_STATE.member });

    // The tab's active org lives in sessionStorage (lib/active-org.ts); without
    // it the Member's tab opens their personal org, where they are an Owner.
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((id) => sessionStorage.setItem('filone:activeOrgId', id), orgId);
    });

    test('offers a member no choice: their key follows the policies', async ({ page }) => {
      await page.goto('/api-keys/create');
      await page.locator('#key-name').fill('policy-e2e-svc-member');
      await page.locator('#key-region').selectOption(REGION);
      await expect(page.getByTestId('access-key-follows-bucket-policy')).toBeVisible();
      await expect(page.getByTestId('access-key-type-service')).toHaveCount(0);
    });
  });
});
