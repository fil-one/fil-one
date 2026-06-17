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
// Size of 23 bytes — `formatBytes(23)` renders as "23 B", which appears in
// the bucket-detail row's accessible name after upload. The name is created
// per upload (see `uniqueObjectName`) so reusing a bucket across runs never
// collides with a previously uploaded object of the same key.
const UPLOAD_FILE = {
  mimeType: 'text/plain',
  buffer: Buffer.from('e2e test upload content'),
} as const;
const UPLOAD_FILE_SIZE_LABEL = '23 B';

function uniqueObjectName(): string {
  return `e2e-upload-${randomUUID()}.txt`;
}

async function createBucketWithKey(page: Page, bucketName: string): Promise<void> {
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('link', { name: 'Buckets' }).click();
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('button', { name: 'Create bucket' }).first().click();
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('textbox', { name: 'Bucket name' }).fill(bucketName);
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('button', { name: 'Create new key' }).click();
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('textbox', { name: 'Key name' }).fill(`${bucketName}-key`);
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('button', { name: 'Create bucket and access key' }).click();
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('button', { name: 'Done' }).click();
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
  // Header has an unconditional "Upload object" button; an empty bucket also
  // renders one in the empty-state card. `.first()` targets the header button.
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('button', { name: 'Upload object' }).first().click();
  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}/upload`);

  // The upload page has two hidden file inputs (a files picker and a folder
  // picker); the files picker is rendered first. Setting files directly on it
  // triggers React's onChange handler, which derives the object key from the
  // file name (empty prefix → key is the file name verbatim).
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ ...UPLOAD_FILE, name: objectName });

  // Submit button on the upload page (different button than the header one we
  // clicked above). It reads "Upload N files"; with a single selected file the
  // label is "Upload 1 file".
  // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
  await page.getByRole('button', { name: 'Upload 1 file', exact: true }).click();
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

    // The file row has role="button"; its accessible name concatenates the
    // file name and formatted size from the table cells.
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await page.getByRole('button', { name: `${objectName} ${UPLOAD_FILE_SIZE_LABEL}` }).click();
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

    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await page.getByRole('button', { name: `${objectName} ${UPLOAD_FILE_SIZE_LABEL}` }).click();
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
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await page.getByRole('link', { name: 'Buckets' }).click();
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await page.getByRole('button', { name: 'Create bucket' }).first().click();
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await page.getByRole('textbox', { name: 'Bucket name' }).fill(bucketName);
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await page.getByRole('button', { name: 'Create bucket' }).click();

    // No navigation on failure — still on the create page.
    await expect(page).toHaveURL(/\/buckets\/create$/);

    // Returning to /buckets should not show a row for this bucket name.
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await page.getByRole('link', { name: 'Buckets' }).click();
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByRole('cell', { name: bucketName })).toHaveCount(0);
  });

  test('unpaid user cannot upload object', async ({ page }) => {
    const bucketName = await openFirstBucket(page);

    await submitUpload(page, bucketName, uniqueObjectName());

    // Presign endpoint returns 403 (GRACE_PERIOD_WRITE_BLOCKED) for past_due
    // accounts; the upload hook catches the error, marks the file as failed,
    // and resets to the idle state on the upload page. The "Retry N failed"
    // button only renders once a failure has been processed, so it is the
    // stable signal that the upload was rejected.
    // oxlint-disable-next-line @filone/oxlint-rules/no-text-locators
    await expect(page.getByRole('button', { name: /Retry \d+ failed/ })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}/upload`);
  });
});
