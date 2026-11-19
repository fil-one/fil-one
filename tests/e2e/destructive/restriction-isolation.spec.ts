import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { ACCOUNT_STATE_TIMEOUT_MS, setAccountState } from './account-state.util.ts';
import { readBucketList } from './buckets.util.ts';
import { requireUserId, STORAGE_STATE } from './roles.util.ts';
import {
  isUnexpired,
  parseRestrictionFixture,
  assertStagingRestrictionProof,
  assertDistinctTenantMappings,
  type RestrictionFixture,
  type RestrictionRegion,
} from './restriction-fixture.util.ts';

const rawFixture = process.env.E2E_RESTRICTION_CONTROL_FIXTURE;
const regions: RestrictionRegion[] = ['eu-west-1', 'us-east-1'];
// Presign responses contain credentials in URLs; retain only the aggregate
// attachment, including on retry, rather than uploading request traces.
test.use({ trace: 'off' });

test('restricts old Aurora/FTH URLs while a distinct control Organization keeps serving', async () => {
  test.skip(
    !rawFixture,
    'Opt in with explicit disposable target/control identities and existing control objects',
  );
  assertStagingRestrictionProof(Resource.App.stage);
  test.setTimeout(15 * 60_000);
  const userId = requireUserId('disabled');
  const fixture = parseRestrictionFixture(
    rawFixture!,
    userId,
    ['PAID', 'UNPAID', 'TRIAL'].map((role) => process.env[`E2E_${role}_USER_ID`] ?? ''),
  );
  const target = await request.newContext({
    baseURL: process.env.BASE_URL,
    storageState: STORAGE_STATE.disabled,
  });
  const control = await request.newContext({
    baseURL: process.env.BASE_URL,
    storageState: fixture.controlStorageState,
  });
  let targetMayHaveChanged = false;
  let restored = false;
  const observations: Array<Record<string, string | number | boolean>> = [];
  try {
    // The helper changes the home Organization. Check that authoritative mapping
    // as well as each authenticated active Organization before invoking it.
    await verifyAuthoritativeMappings(fixture);
    await assertIdentity(target, fixture.targetUserId, fixture.targetOrganizationId);
    await assertIdentity(control, fixture.controlUserId, fixture.controlOrganizationId);
    const controlUrls = new Map<RestrictionRegion, SignedRead>();
    for (const region of regions) {
      const object = fixture.objects[region];
      const signed = await presign(control, region, object);
      await expectServing(signed, object.sha256);
      controlUrls.set(region, signed);
    }

    targetMayHaveChanged = true; // The helper can partially succeed before failing.
    await setAccountState(userId, 'paid');
    const buckets = await readBucketList(await target.get('/api/buckets'));
    const targetUrls = new Map<RestrictionRegion, SignedRead>();
    for (const region of regions) {
      const bucket = buckets.find((item) => item.region === region);
      if (!bucket) throw new Error('Disposable target needs a seeded bucket in Aurora and FTH');
      const body = `Synthetic restriction isolation ${randomUUID()}`;
      const key = `restriction-isolation-${randomUUID()}.txt`;
      const upload = await presign(target, region, { bucket: bucket.bucketName, key }, 'putObject');
      const uploaded = await fetchFixture(upload.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body,
      });
      expect(uploaded.status).toBe(200);
      const signed = await presign(target, region, { bucket: bucket.bucketName, key });
      await expectServing(signed, createHash('sha256').update(body).digest('hex'));
      targetUrls.set(region, signed);
    }

    const started = performance.now();
    const changed = await setAccountState(userId, 'disabled');
    expect(changed.orgId === fixture.targetOrganizationId).toBe(true);
    const legacyNetworks = changed.regions.filter(
      (item) => item.orchestratorId === 'aurora' || item.orchestratorId === 'fth',
    );
    expect(legacyNetworks.map((item) => item.orchestratorId).sort()).toStrictEqual([
      'aurora',
      'fth',
    ]);
    expect(
      legacyNetworks.every((item) => item.outcome === 'updated' || item.outcome === 'in-sync'),
    ).toBe(true);
    const managementElapsedMs = Math.round(performance.now() - started);
    for (const region of regions) {
      const signed = targetUrls.get(region)!;
      let observedAfterStartMs = 0;
      await expect
        .poll(
          async () => {
            const response = await fetchFixture(signed.url);
            const result = { status: response.status, unexpired: isUnexpired(signed.expiresAt) };
            await response.body?.cancel();
            observedAfterStartMs = Math.round(performance.now() - started);
            return result;
          },
          { timeout: 60_000, intervals: [1_000, 5_000, 10_000] },
        )
        .toMatchObject({ status: 403, unexpired: true });
      await expectServing(controlUrls.get(region)!, fixture.objects[region].sha256);
      observations.push({
        region,
        managementElapsedMs,
        observedAfterStartMs,
        controlServed: true,
        targetDeniedBeforeExpiry: true,
      });
    }
  } finally {
    try {
      if (targetMayHaveChanged) {
        test.setTimeout(15 * 60_000 + ACCOUNT_STATE_TIMEOUT_MS);
        await setAccountState(userId, 'disabled');
        restored = true;
      }
    } finally {
      await Promise.allSettled([target.dispose(), control.dispose()]);
      const revision = process.env.GITHUB_SHA;
      await test.info().attach('restriction-isolation-aggregate', {
        contentType: 'application/json',
        body: JSON.stringify({
          revision: revision && /^[a-f0-9]{40}$/i.test(revision) ? revision : undefined,
          scope: 'Aurora and FTH only',
          excludedForgeRegions: ['eu-central-3', 'us-east-9'],
          limit:
            'Up to 60 seconds polling after management completion; not immediate-revocation proof',
          targetRestoredToDisabled: restored,
          observations,
        }),
      });
    }
  }
});

interface SignedRead {
  url: string;
  expiresAt: string;
}

async function verifyAuthoritativeMappings(fixture: RestrictionFixture): Promise<void> {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-2',
    maxAttempts: 1,
  });
  // E2E code intentionally has no generated stage declarations, as in the
  // existing account-state helper; SST supplies this binding at execution.
  const table = (Resource as unknown as Record<string, { name: string }>).UserInfoTable.name;
  try {
    const home = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: { pk: { S: `USER#${fixture.targetUserId}` }, sk: { S: 'PROFILE' } },
        ProjectionExpression: 'orgId',
        ConsistentRead: true,
      }),
    );
    if (home.Item?.orgId?.S !== fixture.targetOrganizationId)
      throw new Error('Unexpected home Organization');
    const profiles = await Promise.all(
      [fixture.targetOrganizationId, fixture.controlOrganizationId].map((org) =>
        client.send(
          new GetItemCommand({
            TableName: table,
            Key: { pk: { S: `ORG#${org}` }, sk: { S: 'PROFILE' } },
            ProjectionExpression: 'auroraTenantId, fthTenantId',
            ConsistentRead: true,
          }),
        ),
      ),
    );
    const mapped = profiles.map((profile) => ({
      'eu-west-1': profile.Item?.auroraTenantId?.S,
      'us-east-1': profile.Item?.fthTenantId?.S,
    }));
    assertDistinctTenantMappings(mapped[0], mapped[1]);
  } catch {
    throw new Error('Unable to verify isolated disposable Organization and tenant mappings');
  } finally {
    client.destroy();
  }
}

async function assertIdentity(
  api: APIRequestContext,
  userId: string,
  orgId: string,
): Promise<void> {
  const response = await api.get('/api/me');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect({
    expectedUser: body.userId === userId,
    expectedOrganization: body.orgId === orgId,
  }).toStrictEqual({ expectedUser: true, expectedOrganization: true });
}

async function presign(
  api: APIRequestContext,
  region: RestrictionRegion,
  { bucket, key }: { bucket: string; key: string },
  op = 'getObject',
): Promise<SignedRead> {
  const { cookies } = await api.storageState();
  const csrf = cookies.find((cookie) => cookie.name === 'hs_csrf_token')?.value ?? '';
  const response = await api.post(`/api/presign?region=${region}`, {
    headers: { 'x-csrf-token': csrf },
    data: [
      {
        op,
        bucket,
        key,
        expiresIn: op === 'getObject' ? 3600 : 300,
        ...(op === 'putObject' ? { contentType: 'text/plain', fileName: key } : {}),
      },
    ],
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  const signed = body.items?.[0];
  if (!signed || typeof signed.url !== 'string' || !isUnexpired(signed.expiresAt))
    throw new Error('Fixture presign did not return a valid unexpired URL');
  return { url: signed.url, expiresAt: signed.expiresAt };
}

async function expectServing(signed: SignedRead, digest: string): Promise<void> {
  const response = await fetchFixture(signed.url);
  const actual = createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex');
  expect({
    status: response.status,
    unexpired: isUnexpired(signed.expiresAt),
    contentMatches: actual === digest.toLowerCase(),
  }).toStrictEqual({ status: 200, unexpired: true, contentMatches: true });
}

async function fetchFixture(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('Disposable fixture transport failed');
  }
}
