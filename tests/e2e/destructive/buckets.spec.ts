import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from './roles.util.ts';
import { REGIONS, type Region } from './regions.util.ts';
import { uniqueBucketName } from './buckets.util.ts';

// In-memory upload fixtures so the tests do not depend on checked-in files.
// Each object key is minted per upload (see `uniqueObjectName`) so reusing a
// bucket across runs never collides with a previously uploaded object.
//
// The image is a 1x1 PNG, so uploading it also checks that the object panel
// can load a preview from the region's S3 endpoint.
const IMAGE_FILE = {
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
  extension: 'png',
} as const;

const AUDIO_FILE = {
  mimeType: 'audio/wav',
  buffer: buildSilentWav(),
  extension: 'wav',
} as const;

type UploadFile = typeof IMAGE_FILE | typeof AUDIO_FILE;

// A file to upload and the object key it is stored under
interface Upload {
  file: UploadFile;
  objectName: string;
}

function uniqueObjectName(file: UploadFile): string {
  return `e2e-upload-${randomUUID()}.${file.extension}`;
}

// A tenth of a second of silence as 8 kHz, 8-bit mono PCM: the smallest file
// every browser's <audio> decodes.
function buildSilentWav(): Buffer {
  const sampleRate = 8000;
  const samples = Buffer.alloc(sampleRate / 10, 0x80); // 0x80 is silence at 8 bits
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // size of the format chunk
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28); // bytes per second
  header.writeUInt16LE(1, 32); // bytes per sample
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

async function createBucketWithKey(page: Page, bucketName: string, region: Region): Promise<void> {
  await page.getByTestId('nav-buckets').click();
  await page.locator('#buckets-create-button').click();
  await page.locator('#bucket-name').fill(bucketName);
  await page.locator('#bucket-region').click();
  await page.locator(`[data-testid="region-option"][data-region="${region}"]`).click();
  await page.locator('#create-bucket-submit-button').click();
  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}`);
  // Through the API Keys tab rather than the empty state's button: the empty state offers
  // View API keys instead whenever a key already reaches the bucket, as a creator's own keys
  // do on an iam region.
  await page.getByTestId('bucket-keys-tab').click();
  await page.locator('#bucket-add-key-button').click();
  await page.locator('#key-name').fill(`${bucketName}-key`);
  await page.locator('#add-bucket-key-submit-button').click();
  await page.locator('#save-credentials-done-button').click();
}

// Opens the first bucket listed at /buckets for the given region and returns
// its name. Bucket links carry the region as a search param
// (/buckets/<name>?region=<region>), which is the stable per-region hook.
// Upload tests reuse existing buckets rather than creating new ones because
// the account-wide bucket limit is 100 and buckets are not yet deletable. The
// `destructive-seed-buckets` project (buckets.setup.ts) creates a bucket per region for
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
  upload: Upload,
  region: Region,
): Promise<void> {
  const { objectName } = upload;
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

  await submitUpload(page, bucketName, upload);

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
async function submitUpload(
  page: Page,
  bucketName: string,
  { file, objectName }: Upload,
): Promise<void> {
  // The page header CTA renders only for non-empty buckets; an empty bucket
  // offers the upload CTA in the object browser's empty state instead. The
  // unpaid role's buckets are always empty, since that role can never upload.
  await page.locator('#upload-object-button, #object-browser-upload-button').first().click();
  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}/upload`);

  // Setting files directly on the (hidden) files input triggers React's
  // onChange handler, which derives the object key from the file name (empty
  // prefix → key is the file name verbatim).
  await page
    .locator('#upload-file-input')
    .setInputFiles({ mimeType: file.mimeType, buffer: file.buffer, name: objectName });

  await page.locator('#upload-submit-button').click();
}

// Uploads a file and opens it in the object panel from the bucket's list.
async function uploadAndOpenInPanel(
  page: Page,
  region: Region,
  file: UploadFile,
): Promise<{ bucketName: string; objectName: string }> {
  const bucketName = await openFirstBucketInRegion(page, region);
  const objectName = uniqueObjectName(file);

  await submitUploadExpectingSuccess(page, bucketName, { file, objectName }, region);

  // On success the upload page navigates back to the bucket detail page.
  await expect(page).toHaveURL(
    (url) => url.pathname === `/buckets/${bucketName}` && url.searchParams.get('region') === region,
  );

  // The object row is keyed by its object key via data-object-key. Clicking it
  // opens the object panel beside the list, named in the URL's `object` param.
  await page.locator(`[data-testid="object-row"][data-object-key="${objectName}"]`).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === `/buckets/${bucketName}` &&
      url.searchParams.get('region') === region &&
      url.searchParams.get('object') === objectName,
  );
  await expect(page.getByTestId('object-details-drawer-panel')).toBeVisible();
  return { bucketName, objectName };
}

// The preview loads straight from a presigned URL on the region's S3 endpoint,
// so the page's CSP must allow that host for images and media. A blocked or
// failed load swaps the element for the "Preview didn't load" placeholder, so
// the element never reaches the state polled for here.
async function expectImagePreviewLoaded(page: Page, objectName: string): Promise<void> {
  const image = page
    .getByTestId('object-details-drawer-panel')
    .locator('img[data-testid="object-preview-media"]');
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      message: `the preview of ${objectName} never decoded`,
    })
    .toBeGreaterThan(0);
}

async function expectAudioPreviewLoaded(page: Page, objectName: string): Promise<void> {
  const audio = page
    .getByTestId('object-details-drawer-panel')
    .locator('audio[data-testid="object-preview-media"]');
  // HAVE_METADATA (1) or later: the browser fetched and parsed the file
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState), {
      message: `the player for ${objectName} never loaded its metadata`,
    })
    .toBeGreaterThanOrEqual(1);
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

    test(`paid user can upload an image and preview it in the object panel (${region})`, async ({
      page,
    }) => {
      test.setTimeout(UPLOAD_TEST_TIMEOUT_MS);

      const { bucketName, objectName } = await uploadAndOpenInPanel(page, region, IMAGE_FILE);
      await expectImagePreviewLoaded(page, objectName);

      // The panel's expand button leads to the object's own page
      await page.getByTestId('object-details-drawer-expand').click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/buckets/${bucketName}/objects` &&
          url.searchParams.get('region') === region &&
          url.searchParams.get('key') === objectName,
      );
    });

    test(`paid user can play an uploaded audio file in the object panel (${region})`, async ({
      page,
    }) => {
      test.setTimeout(UPLOAD_TEST_TIMEOUT_MS);

      const { objectName } = await uploadAndOpenInPanel(page, region, AUDIO_FILE);
      await expectAudioPreviewLoaded(page, objectName);
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

    test(`trial user can upload an image and preview it in the object panel (${region})`, async ({
      page,
    }) => {
      test.setTimeout(UPLOAD_TEST_TIMEOUT_MS);

      const { bucketName, objectName } = await uploadAndOpenInPanel(page, region, IMAGE_FILE);
      await expectImagePreviewLoaded(page, objectName);

      // The panel's expand button leads to the object's own page
      await page.getByTestId('object-details-drawer-expand').click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/buckets/${bucketName}/objects` &&
          url.searchParams.get('region') === region &&
          url.searchParams.get('key') === objectName,
      );
    });

    test(`trial user can play an uploaded audio file in the object panel (${region})`, async ({
      page,
    }) => {
      test.setTimeout(UPLOAD_TEST_TIMEOUT_MS);

      const { objectName } = await uploadAndOpenInPanel(page, region, AUDIO_FILE);
      await expectAudioPreviewLoaded(page, objectName);
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
      await page.locator('#bucket-region').click();
      await page.locator(`[data-testid="region-option"][data-region="${region}"]`).click();
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

      await submitUpload(page, bucketName, {
        file: IMAGE_FILE,
        objectName: uniqueObjectName(IMAGE_FILE),
      });

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
