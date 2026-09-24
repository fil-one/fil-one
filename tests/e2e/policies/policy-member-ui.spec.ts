import { test, expect, type Page } from '@playwright/test';
import type { CreateAccessKeyResponse } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  PAYLOAD,
  REGION,
  STORAGE_STATE,
  allow,
  credentials,
  listObjects,
  ownersStatement,
  removeBucket,
  s3For,
  uniqueBucketName,
} from './policy.util.ts';

// The console as the Member sees it on an `iam` region, and the key and
// bucket forms there. Each case gets its own buckets.

const ownerId = credentials('owner').userId;
const memberId = credentials('member').userId;

let orgId: string;
let owner: ConsoleApi;
let buckets: string[] = [];
const minted: { api: ConsoleApi; id: string }[] = [];

test.beforeAll(async () => {
  orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
});

test.afterEach(async () => {
  await runCleanup([
    ...buckets.splice(0).map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => removeBucket(owner, ownerId, bucket),
    })),
    ...minted
      .splice(0)
      .map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
});

test.afterAll(async () => {
  await owner.dispose();
});

/** A bucket the Owner creates, with the Member granted `actions` (none: not named). */
async function bucketGranting(actions: string[]): Promise<string> {
  const bucket = uniqueBucketName('mem');
  await owner.createBucket(bucket);
  buckets.push(bucket);
  if (actions.length > 0) {
    await owner.setStatements(bucket, [
      ownersStatement(ownerId),
      allow([memberId], actions as ['s3:ListBucket']),
    ]);
  }
  return bucket;
}

async function objectKeys(bucket: string): Promise<string[]> {
  const key = await owner.mintKey();
  minted.push({ api: owner, id: key.id });
  const { Contents = [] } = await listObjects(s3For(key), bucket);
  return Contents.map((o) => o.Key!);
}

test.describe('as the member', () => {
  test.use({ storageState: STORAGE_STATE.member });

  // The tab's active org lives in sessionStorage (lib/active-org.ts).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((id) => sessionStorage.setItem('filone:activeOrgId', id), orgId);
  });

  const openBucket = (page: Page, bucket: string) =>
    page.goto(`/buckets/${bucket}?region=${REGION}`);

  async function upload(page: Page, bucket: string, key: string): Promise<void> {
    await openBucket(page, bucket);
    await page.locator('#upload-object-button, #object-browser-upload-button').first().click();
    await page
      .locator('#upload-file-input')
      .setInputFiles({ name: key, mimeType: 'text/plain', buffer: PAYLOAD });
    await page.locator('#upload-submit-button').click();
  }

  test('M1. a granted bucket opens without a Policy tab', async ({ page }) => {
    const bucket = await bucketGranting(['s3:ListBucket', 's3:GetObject']);
    await openBucket(page, bucket);
    await expect(page.locator('#bucket-detail-heading')).toHaveText(bucket);
    await expect(page.getByTestId('bucket-error')).toHaveCount(0);
    await expect(page.getByTestId('bucket-policy-tab')).toHaveCount(0);
  });

  test('M2. the bucket list shows only buckets a statement names them in', async ({ page }) => {
    const granted = await bucketGranting(['s3:ListBucket']);
    const hidden = await bucketGranting([]);
    await page.goto('/buckets');
    await expect(
      page.locator(`[data-testid="bucket-row"][data-bucket-name="${granted}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="bucket-row"][data-bucket-name="${hidden}"]`),
    ).toHaveCount(0);
  });

  test('M3. an ungranted bucket reads like one that does not exist', async ({ page }) => {
    const hidden = await bucketGranting([]);
    await openBucket(page, uniqueBucketName('missing'));
    const missingMessage = await page.getByTestId('bucket-error').textContent();
    await openBucket(page, hidden);
    await expect(page.getByTestId('bucket-error')).toHaveText(missingMessage!);
  });

  test('M4. the member uploads where the policy grants writes', async ({ page }) => {
    const bucket = await bucketGranting(['s3:ListBucket', 's3:GetObject', 's3:PutObject']);
    await upload(page, bucket, 'member-upload.txt');
    await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucket}`);
    await expect(
      page.locator('[data-testid="object-row"][data-object-key="member-upload.txt"]'),
    ).toBeVisible();
    expect(await objectKeys(bucket)).toEqual(['member-upload.txt']);
  });

  test('M5. an upload the policy does not grant fails and stores nothing', async ({ page }) => {
    const bucket = await bucketGranting(['s3:ListBucket', 's3:GetObject']);
    await upload(page, bucket, 'member-upload.txt');
    await expect(page.locator('#upload-retry-button')).toBeVisible();
    expect(await objectKeys(bucket)).toEqual([]);
  });
});

test.describe('as the owner', () => {
  test.use({ storageState: STORAGE_STATE.owner });

  async function expectPrincipalKeyFields(page: Page): Promise<void> {
    await expect(page.getByTestId('access-key-follows-policy')).toBeVisible();
    await expect(page.getByTestId('access-key-permissions')).toHaveCount(0);
  }

  test('K1. a key created on an iam region asks only for a name and an expiry', async ({
    page,
  }) => {
    await page.goto('/api-keys/create');
    await page.locator('#key-name').fill('policy-e2e-ui-key');
    await page.locator('#key-region').selectOption(REGION);
    await expectPrincipalKeyFields(page);

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/access-keys') && r.request().method() === 'POST',
    );
    await page.locator('#create-api-key-submit-button').click();
    const key = (await (await created).json()) as CreateAccessKeyResponse;
    minted.push({ api: owner, id: key.id });
    expect(key.principalId).toBe(ownerId);

    await page.locator('#save-credentials-done-button').click();
    const row = page.locator(
      `[data-testid="access-key-row"][data-access-key-id="${key.accessKeyId}"]`,
    );
    await expect(row.getByTestId('permission-badge-follows-policy')).toBeVisible();
  });

  test('K2. a bucket created on an iam region carries the owners statement', async ({ page }) => {
    const bucket = uniqueBucketName('form');
    buckets.push(bucket);
    await page.goto('/buckets');
    await page.locator('#buckets-create-button').click();
    await page.locator('#bucket-name').fill(bucket);
    await page.locator('#bucket-region').selectOption(REGION);
    await page.locator('#create-bucket-toggle-key').click();
    await expectPrincipalKeyFields(page);
    await page.locator('#create-bucket-toggle-key').click();
    await page.locator('#create-bucket-submit-button').click();
    await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucket}`);

    await page.getByTestId('bucket-policy-tab').click();
    await expect(page.getByTestId('policy-statement')).toHaveCount(1);
    await expect(page.getByTestId('policy-statement')).toContainText('Owners');
    expect((await owner.readPolicy(bucket)).policy).toEqual({
      statement: [ownersStatement(ownerId)],
    });
  });
});
