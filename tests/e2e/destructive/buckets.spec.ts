import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from './roles.util.ts';

// Bucket names are globally unique (Aurora-backed) and rejected with 409 if
// taken, so each test mints a fresh name. We do not delete buckets afterward
// because Aurora does not yet support deletion — the UI delete button is
// disabled for the same reason (see packages/website/src/pages/BucketsPage.tsx).
function uniqueBucketName(role: string): string {
  return `e2e-${role}-${randomUUID()}`;
}

// In-memory upload fixture so the test does not depend on a checked-in file.
// The object key is minted per upload (see `uniqueObjectName`) so reusing a
// bucket across runs never collides with a previously uploaded object.
const UPLOAD_FILE = {
  mimeType: 'text/plain',
  buffer: Buffer.from('e2e test upload content'),
} as const;

function uniqueObjectName(): string {
  return `e2e-upload-${randomUUID()}.txt`;
}

async function createBucketWithKey(page: Page, bucketName: string): Promise<void> {
  await page.getByTestId('nav-buckets').click();
  await page.locator('#buckets-create-button').click();
  await page.locator('#bucket-name').fill(bucketName);
  await page.locator('#create-bucket-toggle-key').click();
  await page.locator('#key-name').fill(`${bucketName}-key`);
  await page.locator('#create-bucket-submit-button').click();
  await page.locator('#save-credentials-done-button').click();
  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}`);
}

// Opens the first bucket listed at /buckets and returns its name. Upload tests
// reuse existing buckets rather than creating new ones because the account-wide
// bucket limit is 100 and buckets are not yet deletable.
async function openFirstBucket(page: Page): Promise<string> {
  await page.goto('/buckets');
  const firstBucketLink = page.locator('tbody a[href^="/buckets/"]').first();
  await expect(firstBucketLink).toBeVisible();
  await firstBucketLink.click();
  await page.waitForURL((url) => /^\/buckets\/[^/]+$/.test(url.pathname));
  return new URL(page.url()).pathname.split('/').pop()!;
}

// Drives the upload form on the bucket detail page: opens the upload page,
// selects the in-memory file under the given object name, and submits. Stops
// at submit so callers can assert success or failure for their role.
async function submitUpload(page: Page, bucketName: string, objectName: string): Promise<void> {
  await page.locator('#upload-object-button').click();
  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}/upload`);

  // Setting files directly on the (hidden) files input triggers React's
  // onChange handler, which derives the object key from the file name (empty
  // prefix → key is the file name verbatim).
  await page.locator('#upload-file-input').setInputFiles({ ...UPLOAD_FILE, name: objectName });

  await page.locator('#upload-submit-button').click();
}

test.describe('paid user', () => {
  test.use({ storageState: STORAGE_STATE.paid });

  // TODO: Re-enable once bucket deletion lands so we can clean up after each
  // run. Account-wide bucket limit is 100 and buckets are not yet deletable.
  // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
  test.skip('paid user can create bucket and access key', async ({ page }) => {
    await page.goto('/dashboard');
    await createBucketWithKey(page, uniqueBucketName('paid'));
  });

  test('paid user can upload object and navigate to it', async ({ page }) => {
    const bucketName = await openFirstBucket(page);
    const objectName = uniqueObjectName();

    await submitUpload(page, bucketName, objectName);

    // On success the upload page navigates back to the bucket detail page.
    await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}`);

    // The object row is keyed by its object key via data-object-key.
    await page.locator(`[data-testid="object-row"][data-object-key="${objectName}"]`).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/buckets/${bucketName}/objects` &&
        url.searchParams.get('key') === objectName,
    );
  });
});

test.describe('trial user', () => {
  test.use({ storageState: STORAGE_STATE.trial });

  // TODO: Re-enable once bucket deletion lands so we can clean up after each
  // run. Account-wide bucket limit is 100 and buckets are not yet deletable.
  // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
  test.skip('trial user can create bucket and access key', async ({ page }) => {
    await page.goto('/dashboard');
    await createBucketWithKey(page, uniqueBucketName('trial'));
  });

  test('trial user can upload object and navigate to it', async ({ page }) => {
    const bucketName = await openFirstBucket(page);
    const objectName = uniqueObjectName();

    await submitUpload(page, bucketName, objectName);

    await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}`);

    await page.locator(`[data-testid="object-row"][data-object-key="${objectName}"]`).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/buckets/${bucketName}/objects` &&
        url.searchParams.get('key') === objectName,
    );
  });
});

test.describe('unpaid user', () => {
  test.use({ storageState: STORAGE_STATE.unpaid });

  test('unpaid user cannot create bucket', async ({ page }) => {
    const bucketName = uniqueBucketName('unpaid');

    await page.goto('/dashboard');
    await page.getByTestId('nav-buckets').click();
    await page.locator('#buckets-create-button').click();
    await page.locator('#bucket-name').fill(bucketName);
    await page.locator('#create-bucket-submit-button').click();

    // No navigation on failure — still on the create page.
    await expect(page).toHaveURL(/\/buckets\/create$/);

    // Returning to /buckets should not show a row for this bucket name.
    await page.getByTestId('nav-buckets').click();
    await expect(
      page.locator(`[data-testid="bucket-row"][data-bucket-name="${bucketName}"]`),
    ).toHaveCount(0);
  });

  test('unpaid user cannot upload object', async ({ page }) => {
    const bucketName = await openFirstBucket(page);

    await submitUpload(page, bucketName, uniqueObjectName());

    // Presign endpoint returns 403 (GRACE_PERIOD_WRITE_BLOCKED) for past_due
    // accounts; the upload hook catches the error, marks the file as failed,
    // and resets to the idle state on the upload page. The #upload-retry-button
    // only renders once a failure has been processed, so it is the stable
    // signal that the upload was rejected.
    await expect(page.locator('#upload-retry-button')).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}/upload`);
  });
});
