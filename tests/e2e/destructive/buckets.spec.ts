import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from './roles.util.ts';
import { REGIONS, type Region } from './regions.util.ts';
import { uniqueBucketName } from './buckets.util.ts';

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

async function createBucketWithKey(page: Page, bucketName: string, region: Region): Promise<void> {
  await page.getByTestId('nav-buckets').click();
  await page.locator('#buckets-create-button').click();
  await page.locator('#bucket-name').fill(bucketName);
  await page.locator('#bucket-region').selectOption(region);
  await page.locator('#create-bucket-toggle-key').click();
  await page.locator('#key-name').fill(`${bucketName}-key`);
  await page.locator('#create-bucket-submit-button').click();
  await page.locator('#save-credentials-done-button').click();
  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}`);
}

// Opens the first bucket listed at /buckets for the given region and returns
// its name. Bucket links carry the region as a search param
// (/buckets/<name>?region=<region>), which is the stable per-region hook.
// Upload tests reuse existing buckets rather than creating new ones because
// the account-wide bucket limit is 100 and buckets are not yet deletable. The
// `seed-buckets` project (buckets.setup.ts) creates a bucket per region for
// every role that has none, so reaching the assertion below means the seeding
// did not run or did not cover this region.
async function openFirstBucketInRegion(page: Page, region: Region): Promise<string> {
  await page.goto('/buckets');
  const firstBucketLink = page
    .locator(`tbody [data-testid="bucket-link"][href*="region=${region}"]`)
    .first();
  await expect(
    firstBucketLink,
    `No ${region} bucket found for this test account — check the bucket seeding in buckets.setup.ts (see README "Seeded buckets per region")`,
  ).toBeVisible();
  await firstBucketLink.click();
  await page.waitForURL((url) => /^\/buckets\/[^/]+$/.test(url.pathname));
  return new URL(page.url()).pathname.split('/').pop()!;
}

// A rejected PUT to a region's S3 endpoint has taken ~30s to come back (a 502
// from the us-east-1 backend on staging), so the waits below — and the test
// timeout they run under — must outlast that, otherwise the diagnostic is never
// reached and the failure is again an opaque timeout.
const PRESIGN_TIMEOUT_MS = 30_000;
const UPLOAD_PUT_TIMEOUT_MS = 60_000;
const UPLOAD_TEST_TIMEOUT_MS = 120_000;

// Submits an upload and fails with the failing request's region, status and body
// when it does not reach the object store. Uploading is two round-trips — POST
// /api/presign for the URL, then a PUT straight to the region's S3 endpoint —
// and neither failure navigates anywhere, so waiting only for the navigation
// back to the bucket page reports every breakage as the same opaque toHaveURL
// timeout: a region whose storage backend 502s looks exactly like a hung
// browser. Read both responses instead, the way the `unpaid user cannot create
// bucket` test below waits on GET /api/buckets.
//
// Callers must raise the test timeout to UPLOAD_TEST_TIMEOUT_MS at the top of
// the test body: the waits below can consume up to 90s on their own, and the
// navigation that precedes them is subject to the same slow backends.
async function submitUploadExpectingSuccess(
  page: Page,
  bucketName: string,
  objectName: string,
  region: Region,
): Promise<void> {
  const presignResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/api/presign') &&
      response.request().method() === 'POST',
    { timeout: PRESIGN_TIMEOUT_MS },
  );
  // The PUT goes to the region's own endpoint (see getS3Endpoint in
  // packages/shared/src/constants.ts), not to the app origin, and its path ends
  // in the object key.
  const putResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith(`/${objectName}`),
    { timeout: UPLOAD_PUT_TIMEOUT_MS },
  );

  await submitUpload(page, bucketName, objectName);

  const presign = await presignResponse;
  if (!presign.ok()) {
    // No PUT follows a failed presign, so the wait above would eventually time
    // out and reject with nobody awaiting it — an unhandled rejection that
    // buries the presign diagnostic we are about to throw.
    putResponse.catch(() => {});
    throw new Error(
      `POST /api/presign returned ${presign.status()} for a putObject in ${region} ` +
        `(bucket "${bucketName}", key "${objectName}"). Response body: ${await presign.text()}`,
    );
  }

  const put = await putResponse;
  if (!put.ok()) {
    throw new Error(
      `PUT ${new URL(put.url()).origin} returned ${put.status()} when uploading "${objectName}" ` +
        `to "${bucketName}" in ${region}, so the region's storage backend rejected the write. ` +
        `Response body: ${await put.text()}`,
    );
  }
}

// Drives the upload form on the bucket detail page: opens the upload page,
// selects the in-memory file under the given object name, and submits. Stops
// at submit so callers can assert success or failure for their role.
async function submitUpload(page: Page, bucketName: string, objectName: string): Promise<void> {
  // The page header CTA renders only for non-empty buckets; an empty bucket
  // offers the upload CTA in the object browser's empty state instead. The
  // unpaid role's buckets are always empty, since that role can never upload.
  await page.locator('#upload-object-button, #object-browser-upload-button').first().click();
  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}/upload`);

  // Setting files directly on the (hidden) files input triggers React's
  // onChange handler, which derives the object key from the file name (empty
  // prefix → key is the file name verbatim).
  await page.locator('#upload-file-input').setInputFiles({ ...UPLOAD_FILE, name: objectName });

  await page.locator('#upload-submit-button').click();
}

for (const region of REGIONS) {
  test.describe(`paid user (${region})`, () => {
    test.use({ storageState: STORAGE_STATE.paid });

    // TODO: Re-enable once this spec has a teardown step that empties and deletes
    // the bucket it creates. Bucket deletion itself is now implemented for every
    // region; what is missing is the cleanup, and the account-wide bucket limit is
    // 100.
    // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
    test.skip(`paid user can create bucket and access key (${region})`, async ({ page }) => {
      await page.goto('/dashboard');
      await createBucketWithKey(page, uniqueBucketName('paid', region), region);
    });

    test(`paid user can upload object and navigate to it (${region})`, async ({ page }) => {
      test.setTimeout(UPLOAD_TEST_TIMEOUT_MS);

      const bucketName = await openFirstBucketInRegion(page, region);
      const objectName = uniqueObjectName();

      await submitUploadExpectingSuccess(page, bucketName, objectName, region);

      // On success the upload page navigates back to the bucket detail page.
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/buckets/${bucketName}` && url.searchParams.get('region') === region,
      );

      // The object row is keyed by its object key via data-object-key.
      await page.locator(`[data-testid="object-row"][data-object-key="${objectName}"]`).click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/buckets/${bucketName}/objects` &&
          url.searchParams.get('region') === region &&
          url.searchParams.get('key') === objectName,
      );
    });
  });

  test.describe(`trial user (${region})`, () => {
    test.use({ storageState: STORAGE_STATE.trial });

    // TODO: Re-enable once this spec has a teardown step that empties and deletes
    // the bucket it creates. Bucket deletion itself is now implemented for every
    // region; what is missing is the cleanup, and the account-wide bucket limit is
    // 100.
    // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
    test.skip(`trial user can create bucket and access key (${region})`, async ({ page }) => {
      await page.goto('/dashboard');
      await createBucketWithKey(page, uniqueBucketName('trial', region), region);
    });

    test(`trial user can upload object and navigate to it (${region})`, async ({ page }) => {
      test.setTimeout(UPLOAD_TEST_TIMEOUT_MS);

      const bucketName = await openFirstBucketInRegion(page, region);
      const objectName = uniqueObjectName();

      await submitUploadExpectingSuccess(page, bucketName, objectName, region);

      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/buckets/${bucketName}` && url.searchParams.get('region') === region,
      );

      await page.locator(`[data-testid="object-row"][data-object-key="${objectName}"]`).click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/buckets/${bucketName}/objects` &&
          url.searchParams.get('region') === region &&
          url.searchParams.get('key') === objectName,
      );
    });
  });

  test.describe(`unpaid user (${region})`, () => {
    test.use({ storageState: STORAGE_STATE.unpaid });

    test(`unpaid user cannot create bucket (${region})`, async ({ page }) => {
      const bucketName = uniqueBucketName('unpaid', region);

      await page.goto('/dashboard');
      await page.getByTestId('nav-buckets').click();
      await page.locator('#buckets-create-button').click();
      await page.locator('#bucket-name').fill(bucketName);
      await page.locator('#bucket-region').selectOption(region);
      await page.locator('#create-bucket-submit-button').click();

      // No navigation on failure — still on the create page.
      await expect(page).toHaveURL(/\/buckets\/create$/);

      // Returning to /buckets should not show a row for this bucket name. The
      // page renders the cached list immediately and refetches in the background
      // with no visible spinner, so toHaveCount(0) could pass against a stale
      // list before the fresh server response lands. Clicking the nav link would
      // not force that fetch: useBucketsListing keeps the list fresh for
      // LIST_STALE_TIME, so an in-app navigation inside that window serves the
      // cache and issues no request. Load the document instead — a fresh page
      // gets a fresh QueryClient, so the list always comes from the server.
      const listResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/api/buckets') &&
          response.request().method() === 'GET' &&
          response.ok(),
      );
      await page.goto('/buckets');
      await listResponse;
      await expect(
        page.locator(`[data-testid="bucket-row"][data-bucket-name="${bucketName}"]`),
      ).toHaveCount(0);
    });

    test(`unpaid user cannot upload object (${region})`, async ({ page }) => {
      const bucketName = await openFirstBucketInRegion(page, region);

      await submitUpload(page, bucketName, uniqueObjectName());

      // Presign endpoint returns 403 (GRACE_PERIOD_WRITE_BLOCKED) for past_due
      // accounts; the upload hook catches the error, marks the file as failed,
      // and resets to the idle state on the upload page. The #upload-retry-button
      // only renders once a failure has been processed, so it is the stable
      // signal that the upload was rejected.
      await expect(page.locator('#upload-retry-button')).toBeVisible();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/buckets/${bucketName}/upload` &&
          url.searchParams.get('region') === region,
      );
    });
  });
}
