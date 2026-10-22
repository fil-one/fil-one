import { randomUUID } from 'node:crypto';
import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { STORAGE_STATE, requireUserId } from './roles.util.ts';
import { REGIONS, type Region } from './regions.util.ts';
import { ACCOUNT_STATE_TIMEOUT_MS, setAccountState } from './account-state.util.ts';

// Disabling an account must cut off the presigned URLs it already handed out
// (FIL-413). A presigned GET is redeemed at the region's storage provider and
// never re-enters the console, so only the provider can refuse it: these tests
// mint one URL per region while the account is active, disable the account the
// way production does (the subscription canceled, the tenants disabled at every
// provider), and expect each provider to answer the same URL with 403.
//
// The `disabled` account rests in the disabled state; this spec switches it to
// `paid` to upload and presign, and puts it back.
//
// Cross-run note: these specs mutate shared staging state, and the suite runs
// with one worker in CI (`workers: isCI ? 1 : undefined`). A local run with
// parallel workers races the browser projects against each other.

const ROLE = 'disabled';
const OBJECT_KEY = 'presigned-revocation-check.txt';

/** Upload, presign and redeem in four regions, plus two Lambda calls. */
const SETUP_TIMEOUT_MS = 2 * ACCOUNT_STATE_TIMEOUT_MS + 120_000;
/** How long a provider may take to start refusing the URL after the disable. */
const REJECTION_POLL_TIMEOUT_MS = 60_000;

interface PresignedObject {
  bucket: string;
  key: string;
  url: string;
}

test.describe('disabled account', () => {
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

      presignedObjects.set(region, { bucket, key, url });
    }

    const disabled = await setAccountState(userId, 'disabled');
    // Every region must have been reached: a region the account was never
    // provisioned in would pass its test without disabling anything.
    expect(
      disabled.regions.filter(({ outcome }) => outcome === 'updated' || outcome === 'in-sync'),
      `the disable must reach a tenant in every region: ${JSON.stringify(disabled.regions)}`,
    ).toHaveLength(REGIONS.length);
  });

  test.afterAll(async () => {
    // The role's resting state, also after a beforeAll that failed while the
    // account was switched to `paid`.
    test.setTimeout(ACCOUNT_STATE_TIMEOUT_MS);
    try {
      await setAccountState(userId, ROLE);
    } finally {
      await api?.dispose();
    }
  });

  for (const region of REGIONS) {
    test(`rejects a presigned GET minted before the tenant was disabled (${region})`, async () => {
      const { url } = presignedObjects.get(region)!;

      await expect
        .poll(
          async () => {
            const response = await fetch(url);
            return { status: response.status, body: await response.text() };
          },
          { timeout: REJECTION_POLL_TIMEOUT_MS },
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

/** The first bucket the account has in each region; buckets.setup.ts seeds one. */
async function findBucketInEachRegion(api: APIRequestContext): Promise<Map<Region, string>> {
  const response = await api.get('/api/buckets');
  if (!response.ok()) {
    throw new Error(`GET /api/buckets returned ${response.status()}: ${await response.text()}`);
  }
  const { buckets } = (await response.json()) as {
    buckets: Array<{ bucketName: string; region: string }>;
  };

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
  const contentType = 'text/plain';
  const url = await presignUrl(api, csrfToken, region, {
    op: 'putObject',
    bucket,
    key,
    contentType,
    fileName: key,
  });
  const uploaded = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  });
  if (!uploaded.ok) {
    throw new Error(
      `PUT to the presigned URL in ${region} returned ${uploaded.status}: ${await uploaded.text()}`,
    );
  }
}

function presignGetUrl(
  api: APIRequestContext,
  csrfToken: string,
  { region, bucket, key }: { region: Region; bucket: string; key: string },
): Promise<string> {
  // Longer than the default 300 s, so the URL is still valid when the
  // rejection tests run after a slow disable.
  return presignUrl(api, csrfToken, region, { op: 'getObject', bucket, key, expiresIn: 3600 });
}

async function presignUrl(
  api: APIRequestContext,
  csrfToken: string,
  region: Region,
  op: Record<string, unknown>,
): Promise<string> {
  const response = await sendPresignRequest(api, csrfToken, region, [op]);
  if (!response.ok()) {
    throw new Error(
      `POST /api/presign (${String(op.op)} in ${region}) returned ${response.status()}: ` +
        (await response.text()),
    );
  }
  const { items } = (await response.json()) as { items: Array<{ url: string }> };
  return items[0].url;
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
