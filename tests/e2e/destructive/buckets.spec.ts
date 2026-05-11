import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from './roles.ts';

// Bucket names are globally unique (Aurora-backed) and rejected with 409 if
// taken, so each test mints a fresh name. We do not delete buckets afterward
// because Aurora does not yet support deletion — the UI delete button is
// disabled for the same reason (see packages/website/src/pages/BucketsPage.tsx).
function uniqueBucketName(role: string): string {
  return `e2e-${role}-${randomUUID()}`;
}

// In-memory upload fixture so the test does not depend on a checked-in file.
// Size of 23 bytes — `formatBytes(23)` renders as "23 B", which appears in
// the bucket-detail row's accessible name after upload.
const UPLOAD_FILE = {
  name: 'e2e-upload.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('e2e test upload content'),
} as const;
const UPLOAD_FILE_SIZE_LABEL = '23 B';

async function createBucketWithKey(page: Page, bucketName: string): Promise<void> {
  await page.getByRole('link', { name: 'Buckets' }).click();
  await page.getByRole('button', { name: 'Create bucket' }).first().click();
  await page.getByRole('textbox', { name: 'Bucket name' }).fill(bucketName);
  await page.getByRole('button', { name: 'Create new key' }).click();
  await page.getByRole('textbox', { name: 'Key name' }).fill(`${bucketName}-key`);
  await page.getByRole('button', { name: 'Create bucket and access key' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(new RegExp(`/buckets/${bucketName}$`));
}

// Opens the first bucket listed at /buckets and returns its name. Upload tests
// reuse existing buckets rather than creating new ones because the account-wide
// bucket limit is 100 and buckets are not yet deletable.
async function openFirstBucket(page: Page): Promise<string> {
  await page.goto('/buckets');
  const firstBucketLink = page.locator('tbody a[href^="/buckets/"]').first();
  await expect(firstBucketLink).toBeVisible();
  await firstBucketLink.click();
  await page.waitForURL(/\/buckets\/[^/]+$/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

// Drives the upload form on the bucket detail page: opens the upload page,
// selects the in-memory file, and submits. Stops at submit so callers can
// assert success or failure for their role.
async function submitUpload(page: Page, bucketName: string): Promise<void> {
  // Header has an unconditional "Upload object" button; an empty bucket also
  // renders one in the empty-state card. `.first()` targets the header button.
  await page.getByRole('button', { name: 'Upload object' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/buckets/${bucketName}/upload$`));

  // The dropzone forwards clicks to a hidden <input type="file">. Setting
  // files directly on the input is the most reliable way to trigger React's
  // onChange handler, which auto-fills the object name from the file name.
  await page.locator('input[type="file"]').setInputFiles({ ...UPLOAD_FILE });

  // Submit button on the upload page (different button than the header one
  // we clicked above — this is the form submit).
  await page.getByRole('button', { name: 'Upload object' }).click();
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

    await submitUpload(page, bucketName);

    // On success the upload page navigates back to the bucket detail page.
    await expect(page).toHaveURL(new RegExp(`/buckets/${bucketName}$`));

    // The file row has role="button"; its accessible name concatenates the
    // file name and formatted size from the table cells.
    await page
      .getByRole('button', { name: `${UPLOAD_FILE.name} ${UPLOAD_FILE_SIZE_LABEL}` })
      .click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/buckets/${bucketName}/objects` &&
        url.searchParams.get('key') === UPLOAD_FILE.name,
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

    await submitUpload(page, bucketName);

    await expect(page).toHaveURL(new RegExp(`/buckets/${bucketName}$`));

    await page
      .getByRole('button', { name: `${UPLOAD_FILE.name} ${UPLOAD_FILE_SIZE_LABEL}` })
      .click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/buckets/${bucketName}/objects` &&
        url.searchParams.get('key') === UPLOAD_FILE.name,
    );
  });
});

test.describe('unpaid user', () => {
  test.use({ storageState: STORAGE_STATE.unpaid });

  test('unpaid user cannot create bucket', async ({ page }) => {
    const bucketName = uniqueBucketName('unpaid');

    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Buckets' }).click();
    await page.getByRole('button', { name: 'Create bucket' }).first().click();
    await page.getByRole('textbox', { name: 'Bucket name' }).fill(bucketName);
    await page.getByRole('button', { name: 'Create bucket' }).click();

    // No navigation on failure — still on the create page.
    await expect(page).toHaveURL(/\/buckets\/create$/);

    // Returning to /buckets should not show a row for this bucket name.
    await page.getByRole('link', { name: 'Buckets' }).click();
    await expect(page.getByRole('cell', { name: bucketName })).toHaveCount(0);
  });

  test('unpaid user cannot upload object', async ({ page }) => {
    const bucketName = await openFirstBucket(page);

    await submitUpload(page, bucketName);

    // Presign endpoint returns 403 (GRACE_PERIOD_WRITE_BLOCKED) for past_due
    // accounts; the upload hook catches the error, resets to the idle state,
    // and stays on the upload page. Wait for the dropzone to reappear, which
    // signals that the failure has been processed.
    await expect(page.getByRole('button', { name: /Drop files here or click to/i })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/buckets/${bucketName}/upload$`));
  });
});
