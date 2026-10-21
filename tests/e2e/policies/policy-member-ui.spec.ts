import { test, expect, type Page } from '@playwright/test';
import type { CreateAccessKeyResponse, PolicyAction } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  PAYLOAD,
  REGION,
  STORAGE_STATE,
  allow,
  getCredentials,
  listObjects,
  grantAllToOwner,
  emptyAndDeleteBucket,
  buildCreatorPolicy,
  createS3ClientWithNewKey,
  generateBucketName,
  toCanonicalPolicy,
} from './policy.util.ts';

// The console as the Member sees it on an `iam` region, and the key and
// bucket forms there. Each case gets its own buckets.

const ownerId = getCredentials('owner').userId;
const memberId = getCredentials('member').userId;

let orgId: string;
let owner: ConsoleApi;
let buckets: string[] = [];
const createdKeys: { api: ConsoleApi; id: string }[] = [];

test.beforeAll(async () => {
  orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
});

test.afterEach(async () => {
  await runCleanup([
    ...buckets.splice(0).map((bucket) => ({
      label: `bucket ${bucket}`,
      run: () => emptyAndDeleteBucket(owner, ownerId, bucket),
    })),
    ...createdKeys
      .splice(0)
      .map(({ api, id }) => ({ label: `key ${id}`, run: () => api.deleteKey(id) })),
  ]);
});

test.afterAll(async () => {
  await owner.dispose();
});

/** A bucket the Owner creates, with the Member granted `actions` (none: not named). */
async function createBucketGrantingMember(actions: PolicyAction[]): Promise<string> {
  const bucket = generateBucketName('mem');
  await owner.createBucket(bucket);
  buckets.push(bucket);
  if (actions.length > 0) {
    await owner.replaceStatements(bucket, [grantAllToOwner(ownerId), allow([memberId], actions)]);
  }
  return bucket;
}

async function listObjectKeysAsOwner(bucket: string): Promise<string[]> {
  const s3 = await createS3ClientWithNewKey(owner, createdKeys);
  const { Contents = [] } = await listObjects(s3, bucket);
  return Contents.map((o) => o.Key!);
}

test.describe('as the member', { tag: '@serial' }, () => {
  test.use({ storageState: STORAGE_STATE.member });

  // The tab's active org lives in sessionStorage (lib/active-org.ts).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((id) => sessionStorage.setItem('filone:activeOrgId', id), orgId);
  });

  const openBucket = (page: Page, bucket: string) =>
    page.goto(`/buckets/${bucket}?region=${REGION}`);

  async function uploadObjectInUi(page: Page, bucket: string, key: string): Promise<void> {
    await openBucket(page, bucket);
    await page.locator('#upload-object-button, #object-browser-upload-button').first().click();
    await page
      .locator('#upload-file-input')
      .setInputFiles({ name: key, mimeType: 'text/plain', buffer: PAYLOAD });
    await page.locator('#upload-submit-button').click();
  }

  test('a granted bucket opens without a Policy tab', async ({ page }) => {
    const bucket = await createBucketGrantingMember(['s3:ListBucket', 's3:GetObject']);
    await openBucket(page, bucket);
    await expect(page.locator('#bucket-detail-heading')).toHaveText(bucket);
    await expect(page.getByTestId('bucket-error')).toHaveCount(0);
    await expect(page.getByTestId('bucket-policy-tab')).toHaveCount(0);
  });

  test('the bucket list shows only the buckets a statement names the member in', async ({
    page,
  }) => {
    const granted = await createBucketGrantingMember(['s3:ListBucket']);
    const hidden = await createBucketGrantingMember([]);
    await page.goto('/buckets');
    await expect(
      page.locator(`[data-testid="bucket-row"][data-bucket-name="${granted}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="bucket-row"][data-bucket-name="${hidden}"]`),
    ).toHaveCount(0);
  });

  test('an ungranted bucket reads like one that does not exist', async ({ page }) => {
    const hidden = await createBucketGrantingMember([]);
    await openBucket(page, generateBucketName('missing'));
    const missingMessage = await page.getByTestId('bucket-error').textContent();
    await openBucket(page, hidden);
    await expect(page.getByTestId('bucket-error')).toHaveText(missingMessage!);
  });

  test('the member uploads where the policy grants writes', async ({ page }) => {
    const bucket = await createBucketGrantingMember([
      's3:ListBucket',
      's3:GetObject',
      's3:PutObject',
    ]);
    await uploadObjectInUi(page, bucket, 'member-upload.txt');
    await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucket}`);
    await expect(
      page.locator('[data-testid="object-row"][data-object-key="member-upload.txt"]'),
    ).toBeVisible();
    expect(await listObjectKeysAsOwner(bucket)).toEqual(['member-upload.txt']);
  });

  test('an upload the policy does not grant fails and stores nothing', async ({ page }) => {
    const bucket = await createBucketGrantingMember(['s3:ListBucket', 's3:GetObject']);
    await uploadObjectInUi(page, bucket, 'member-upload.txt');
    await expect(page.locator('#upload-retry-button')).toBeVisible();
    expect(await listObjectKeysAsOwner(bucket)).toEqual([]);
  });
});

test.describe('as the owner', { tag: '@serial' }, () => {
  test.use({ storageState: STORAGE_STATE.owner });

  async function expectPrincipalKeyFields(page: Page): Promise<void> {
    await expect(page.getByTestId('access-key-follows-bucket-policy')).toBeVisible();
    await expect(page.getByTestId('access-key-permissions')).toHaveCount(0);
  }

  test('a key form on an iam region shows no permission fields and creates a principal key', async ({
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
    createdKeys.push({ api: owner, id: key.id });
    expect(key.principalId).toBe(ownerId);

    await page.locator('#save-credentials-done-button').click();
    const row = page.locator(
      `[data-testid="access-key-row"][data-access-key-id="${key.accessKeyId}"]`,
    );
    await expect(row.getByTestId('permission-badge-follows-bucket-policy')).toBeVisible();
  });

  test('a bucket created on an iam region names its creator', async ({ page }) => {
    const bucket = generateBucketName('form');
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
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
      toCanonicalPolicy(buildCreatorPolicy(bucket, ownerId)),
    );
  });
});
