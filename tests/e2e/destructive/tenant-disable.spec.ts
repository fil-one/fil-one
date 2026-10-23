import { randomUUID } from 'node:crypto';
import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { STORAGE_STATE, requireUserId } from './roles.util.ts';
import { REGIONS, type Region } from './regions.util.ts';
import {
  ACCOUNT_STATE_TIMEOUT_MS,
  setAccountState,
  type AccountStateResult,
} from './account-state.util.ts';
import { readBucketList } from './buckets.util.ts';

// Changing an account's tenant status must reach the presigned URLs it already
// handed out (FIL-413). A presigned URL is redeemed at the region's storage
// provider and never re-enters the console, so only the provider can refuse
// it. These tests mint URLs in every region while the account is active, then
// change the tenant status the way production does and redeem the same URLs:
//
// - A write-locked account (a canceled subscription in its grace period) keeps
//   downloading, and every provider refuses its uploads.
// - A disabled account (the grace period over, the tenants disabled at every
//   provider) is refused downloads too.
//
// The `disabled` account rests in the disabled state; this spec switches it to
// `paid` to upload and presign, and puts it back.
//
// Cross-run note: these specs mutate shared staging state, and the suite runs
// with one worker in CI (`workers: isCI ? 1 : undefined`). A local run with
// parallel workers races the browser projects against each other.

const ROLE = 'disabled';
const OBJECT_KEY = 'presigned-revocation-check.txt';
/** The upload probe has a key of its own, so a PUT the provider accepts by mistake leaves OBJECT_KEY intact. */
const UPLOAD_PROBE_KEY = 'presigned-write-lock-check.txt';

/** Upload, presign and redeem in four regions, plus one Lambda call. */
const SETUP_TIMEOUT_MS = ACCOUNT_STATE_TIMEOUT_MS + 120_000;
/** Presign and redeem a PUT in four regions, plus one Lambda call. */
const WRITE_LOCK_SETUP_TIMEOUT_MS = ACCOUNT_STATE_TIMEOUT_MS + 60_000;
/** How long a provider may take to start refusing the URL after the status change. */
const REJECTION_POLL_TIMEOUT_MS = 60_000;

interface PresignedObject {
  bucket: string;
  key: string;
  body: string;
  url: string;
}

interface PresignedUpload {
  url: string;
  expiresAt: number;
}

test.describe('account with tenants changed after presigning', () => {
  test.describe.configure({ mode: 'serial', timeout: REJECTION_POLL_TIMEOUT_MS + 30_000 });

  const userId = requireUserId(ROLE);
  const presignedObjects = new Map<Region, PresignedObject>();
  let api: APIRequestContext;
  let csrfToken: string;

  test.beforeAll(async () => {
    test.setTimeout(SETUP_TIMEOUT_MS);
    api = await request.newContext({
      baseURL: process.env.BASE_URL,
      ignoreHTTPSErrors: true,
      storageState: STORAGE_STATE[ROLE],
    });
    const { cookies } = await api.storageState();
    csrfToken = cookies.find((cookie) => cookie.name === 'hs_csrf_token')?.value ?? '';

    await setAccountState(userId, 'paid');

    const bucketByRegion = await findBucketInEachRegion(api);
    for (const region of REGIONS) {
      const bucket = bucketByRegion.get(region)!;
      // One key, overwritten each run, so the bucket does not collect objects.
      // The body is new each run, so a 200 proves this run's upload landed.
      const key = OBJECT_KEY;
      const body = `FIL-1259 presigned revocation check ${randomUUID()}`;
      await uploadObject(api, csrfToken, { region, bucket, key, body });
      const url = await presignGetUrl(api, csrfToken, { region, bucket, key });

      const redeemed = await fetch(url);
      expect(
        { status: redeemed.status, body: await redeemed.text() },
        `a presigned GET in ${region} must serve the object while the account is active`,
      ).toStrictEqual({ status: 200, body });

      presignedObjects.set(region, { bucket, key, body, url });
    }
  });

  test.afterAll(async () => {
    // The role's resting state, also after a beforeAll that failed while the
    // account was switched to `paid` or write-locked.
    test.setTimeout(ACCOUNT_STATE_TIMEOUT_MS);
    try {
      await setAccountState(userId, ROLE);
    } finally {
      await api?.dispose();
    }
  });

  test.describe('write-locked', () => {
    const presignedUploads = new Map<Region, PresignedUpload>();

    test.beforeAll(async () => {
      test.setTimeout(WRITE_LOCK_SETUP_TIMEOUT_MS);

      // Minted here rather than with the GET URLs: a PUT URL lives only 300 s,
      // and every second spent before the write lock is one the rejection
      // tests cannot use.
      for (const region of REGIONS) {
        const { bucket } = presignedObjects.get(region)!;
        const upload = await presignPutUrl(api, csrfToken, {
          region,
          bucket,
          key: UPLOAD_PROBE_KEY,
        });

        const redeemed = await putObject(upload.url, `FIL-1259 upload probe ${randomUUID()}`);
        expect(
          { status: redeemed.status, body: await redeemed.text() },
          `a presigned PUT in ${region} must store the object while the account is active`,
        ).toMatchObject({ status: 200 });

        presignedUploads.set(region, upload);
      }

      expectEveryRegionReached(await setAccountState(userId, 'paid_grace_period'));
    });

    for (const region of REGIONS) {
      test(`rejects a presigned PUT minted before the tenant was write-locked (${region})`, async () => {
        const { url, expiresAt } = presignedUploads.get(region)!;

        const startedAt = Date.now();
        await expect
          .poll(
            async () => {
              const response = await putObject(url, `FIL-1259 upload probe ${randomUUID()}`);
              console.log(
                `${region}: ${response.status} after ${Math.round((Date.now() - startedAt) / 1000)} s`,
              );
              return {
                status: response.status,
                body: await response.text(),
                // An expired URL is refused with 403 too, which would pass for
                // the write lock.
                expired: Date.now() >= expiresAt,
              };
            },
            { timeout: REJECTION_POLL_TIMEOUT_MS, intervals: [10_000] },
          )
          .toMatchObject({ status: 403, expired: false });
      });

      test(`serves a presigned GET minted before the tenant was write-locked (${region})`, async () => {
        const { url, body } = presignedObjects.get(region)!;

        const response = await fetch(url);

        expect({ status: response.status, body: await response.text() }).toStrictEqual({
          status: 200,
          body,
        });
      });

      test(`refuses to presign a PUT once the account is write-locked (${region})`, async () => {
        const { bucket } = presignedObjects.get(region)!;

        const response = await sendPresignRequest(api, csrfToken, region, [
          {
            op: 'putObject',
            bucket,
            key: UPLOAD_PROBE_KEY,
            contentType: 'text/plain',
            fileName: UPLOAD_PROBE_KEY,
          },
        ]);

        expect({ status: response.status(), body: await response.json() }).toMatchObject({
          status: 403,
          body: { code: 'GRACE_PERIOD_WRITE_BLOCKED' },
        });
      });

      test(`presigns a GET that serves the object once the account is write-locked (${region})`, async () => {
        const { bucket, key, body } = presignedObjects.get(region)!;

        const url = await presignGetUrl(api, csrfToken, { region, bucket, key });
        const response = await fetch(url);

        expect({ status: response.status, body: await response.text() }).toStrictEqual({
          status: 200,
          body,
        });
      });
    }
  });

  test.describe('disabled', () => {
    test.beforeAll(async () => {
      test.setTimeout(ACCOUNT_STATE_TIMEOUT_MS);
      expectEveryRegionReached(await setAccountState(userId, 'disabled'));
    });

    for (const region of REGIONS) {
      test(`rejects a presigned GET minted before the tenant was disabled (${region})`, async () => {
        test.skip(
          region === 'us-east-1',
          'FTH (us-east-1) has a bug and does not implement this mechanism yet',
        );

        const { url } = presignedObjects.get(region)!;

        const startedAt = Date.now();
        await expect
          .poll(
            async () => {
              const response = await fetch(url);
              console.log(
                `${region}: ${response.status} after ${Math.round((Date.now() - startedAt) / 1000)} s`,
              );
              return { status: response.status, body: await response.text() };
            },
            { timeout: REJECTION_POLL_TIMEOUT_MS, intervals: [10_000] },
          )
          .toMatchObject({ status: 403 });
      });

      test(`refuses to presign a GET once the account is disabled (${region})`, async () => {
        const { bucket, key } = presignedObjects.get(region)!;

        const response = await sendPresignRequest(api, csrfToken, region, [
          { op: 'getObject', bucket, key },
        ]);

        expect({ status: response.status(), body: await response.json() }).toMatchObject({
          status: 403,
          body: { code: 'SUBSCRIPTION_CANCELED' },
        });
      });
    }
  });
});

/**
 * A region the account was never provisioned in would pass its tests without
 * the status change reaching anything.
 */
function expectEveryRegionReached(result: AccountStateResult): void {
  expect(
    result.regions.filter(({ outcome }) => outcome === 'updated' || outcome === 'in-sync'),
    `the status change must reach a tenant in every region: ${JSON.stringify(result.regions)}`,
  ).toHaveLength(REGIONS.length);
}

/** The first bucket the account has in each region; buckets.setup.ts seeds one. */
async function findBucketInEachRegion(api: APIRequestContext): Promise<Map<Region, string>> {
  const buckets = await readBucketList(await api.get('/api/buckets'));

  const bucketByRegion = new Map<Region, string>();
  for (const region of REGIONS) {
    const bucket = buckets.find((candidate) => candidate.region === region);
    if (!bucket) {
      throw new Error(`The ${ROLE} account has no bucket in ${region}; buckets.setup.ts seeds one`);
    }
    bucketByRegion.set(region, bucket.bucketName);
  }
  return bucketByRegion;
}

async function uploadObject(
  api: APIRequestContext,
  csrfToken: string,
  { region, bucket, key, body }: { region: Region; bucket: string; key: string; body: string },
): Promise<void> {
  const { url } = await presignPutUrl(api, csrfToken, { region, bucket, key });
  const uploaded = await putObject(url, body);
  if (!uploaded.ok) {
    throw new Error(
      `PUT to the presigned URL in ${region} returned ${uploaded.status}: ${await uploaded.text()}`,
    );
  }
}

function putObject(url: string, body: string): Promise<Response> {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
}

async function presignPutUrl(
  api: APIRequestContext,
  csrfToken: string,
  { region, bucket, key }: { region: Region; bucket: string; key: string },
): Promise<PresignedUpload> {
  const { url, expiresAt } = await presignUrl(api, csrfToken, region, {
    op: 'putObject',
    bucket,
    key,
    contentType: 'text/plain',
    fileName: key,
  });
  return { url, expiresAt: Date.parse(expiresAt) };
}

async function presignGetUrl(
  api: APIRequestContext,
  csrfToken: string,
  { region, bucket, key }: { region: Region; bucket: string; key: string },
): Promise<string> {
  // Longer than the default 300 s, so the URL is still valid when the
  // rejection tests run after a slow disable.
  const { url } = await presignUrl(api, csrfToken, region, {
    op: 'getObject',
    bucket,
    key,
    expiresIn: 3600,
  });
  return url;
}

async function presignUrl(
  api: APIRequestContext,
  csrfToken: string,
  region: Region,
  op: Record<string, unknown>,
): Promise<{ url: string; expiresAt: string }> {
  const response = await sendPresignRequest(api, csrfToken, region, [op]);
  if (!response.ok()) {
    throw new Error(
      `POST /api/presign (${String(op.op)} in ${region}) returned ${response.status()}: ` +
        (await response.text()),
    );
  }
  const { items } = (await response.json()) as {
    items: Array<{ url: string; expiresAt: string }>;
  };
  return items[0];
}

function sendPresignRequest(
  api: APIRequestContext,
  csrfToken: string,
  region: Region,
  ops: Array<Record<string, unknown>>,
) {
  return api.post(`/api/presign?region=${region}`, {
    data: ops,
    headers: { 'x-csrf-token': csrfToken },
  });
}
