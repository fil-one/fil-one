import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { isRegion, REGIONS, type Region } from './regions.util.ts';

// Bucket names are globally unique across regions and rejected with 409 if
// taken, so each caller mints a fresh name. We do not delete buckets afterward
// because the delete API is not wired for any region yet — it routes to the
// Aurora orchestrator, which does not support deletion, and the UI delete
// button is disabled for the same reason (see
// packages/website/src/pages/BucketsPage.tsx).
export function uniqueBucketName(role: string, region: Region): string {
  return `e2e-${role}-${region}-${randomUUID()}`;
}

// Seeds the logged-in account with one bucket per region, but only for regions
// that have none yet. Staging occasionally resets its storage layer and all
// buckets disappear; without this the upload tests fail until someone re-seeds
// the test accounts by hand. Creation is conditional because buckets are not
// deletable and the account-wide limit is 100
// (https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket).
export async function ensureBucketInEachRegion(page: Page, role: string): Promise<void> {
  const regionsWithBucket = await listRegionsWithBucket(page);
  for (const region of REGIONS) {
    if (regionsWithBucket.has(region)) continue;
    await createBucket(page, uniqueBucketName(role, region), region);
  }
}

// Reads the bucket list from the API response the page fetches on load rather
// than from the rendered table: the DOM cannot distinguish "no buckets" from
// "the list failed to load" (both render no bucket rows), and a failing
// GET /api/buckets must not be mistaken for an empty account — seeding would
// then pile up buckets the account may already have.
async function listRegionsWithBucket(page: Page): Promise<Set<Region>> {
  const listResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/api/buckets') &&
      response.request().method() === 'GET',
  );
  await page.goto('/buckets');
  const response = await listResponse;

  if (!response.ok()) {
    throw new Error(
      `GET /api/buckets returned ${response.status()}, so we cannot tell whether this account ` +
        `has buckets. Check the ListBuckets logs for the stage. Response body: ${await response.text()}`,
    );
  }

  const { buckets } = (await response.json()) as { buckets: Array<{ region: string }> };
  // Regions the account has buckets in but this suite does not know about are
  // irrelevant for seeding, so drop them instead of widening the type.
  return new Set(buckets.map((bucket) => bucket.region).filter(isRegion));
}

// Creates a bucket without an access key. With the key toggle left off, the
// create page navigates straight to the bucket detail page — there is no
// save-credentials dialog to dismiss.
async function createBucket(page: Page, bucketName: string, region: Region): Promise<void> {
  await page.goto('/buckets/create');
  await page.locator('#bucket-name').fill(bucketName);
  await page.locator('#bucket-region').selectOption(region);

  // Read the API response rather than only asserting the navigation: on failure
  // the page stays on /buckets/create and shows a toast, which would surface as
  // an opaque toHaveURL timeout that says nothing about why the region rejected
  // the bucket (e.g. 503 while the tenant is still being provisioned).
  const createResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/api/buckets') &&
      response.request().method() === 'POST',
  );
  await page.locator('#create-bucket-submit-button').click();
  const response = await createResponse;

  if (!response.ok()) {
    throw new Error(
      `POST /api/buckets returned ${response.status()} when creating "${bucketName}" in ` +
        `${region}. Response body: ${await response.text()}`,
    );
  }

  await expect(page).toHaveURL((url) => url.pathname === `/buckets/${bucketName}`);
}
