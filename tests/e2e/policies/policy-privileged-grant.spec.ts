import { test, expect, type Page } from '@playwright/test';
import type { PolicyStatement } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  REGION,
  STORAGE_STATE,
  buildCreatorStatement,
  allow,
  getCredentials,
  deny,
  emptyAndDeleteBucket,
  grantAllToOwner,
  generateBucketName,
  toCanonicalPolicy,
  chooseStatementMenuAction,
} from './policy.util.ts';

// Granting a retention or legal-hold write is `privileged.grant`, which only an
// Owner holds: `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, and `s3:*`,
// which stands for both. An Admin manages policies but may not newly grant the
// pair; a grant the stored policy already makes is not new. A retention write
// named outright is held to the stored policy by name, so an Admin may keep or
// drop one an Owner wrote but not add one, even for an Owner.

const ownerId = getCredentials('owner').userId;
const adminId = getCredentials('admin').userId;
const memberId = getCredentials('member').userId;

let orgId: string;
let owner: ConsoleApi;
let admin: ConsoleApi;
let bucket: string;

test.beforeAll(async () => {
  orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  admin = await ConsoleApi.open('admin', orgId);
});

test.beforeEach(async () => {
  bucket = generateBucketName('priv');
  await owner.createBucket(bucket);
});

test.afterEach(async () => {
  await runCleanup([
    { label: `bucket ${bucket}`, run: () => emptyAndDeleteBucket(owner, ownerId, bucket) },
  ]);
});

test.afterAll(async () => {
  await owner.dispose();
  await admin.dispose();
});

/** The policy a bucket starts with here: the owner created it. */
const getStoredStatements = () => [buildCreatorStatement(ownerId)];

async function putPolicyAs(api: ConsoleApi, statements: PolicyStatement[], etag?: string) {
  const res = await api.putPolicy(bucket, { policy: { Statement: statements }, etag });
  // A write that succeeds answers 204 with no body.
  const text = await res.text();
  return {
    status: res.status(),
    code: text ? (JSON.parse(text) as { code?: string }).code : undefined,
  };
}

test.describe('through the API', () => {
  for (const [title, grant] of [
    [
      'P1a. an admin cannot newly grant s3:PutObjectRetention',
      allow([memberId], ['s3:PutObjectRetention']),
    ],
    [
      'P1b. an admin cannot newly grant s3:PutObjectLegalHold',
      allow([memberId], ['s3:PutObjectLegalHold']),
    ],
    ['P1c. an admin cannot newly grant s3:*', allow([memberId], ['s3:*'])],
    [
      'P1d. an admin cannot newly grant s3:PutObjectLegalHold to everyone',
      allow('*', ['s3:PutObjectLegalHold']),
    ],
    [
      'P1e. an admin cannot newly grant s3:PutObjectRetention to themselves',
      allow([adminId], ['s3:PutObjectRetention']),
    ],
  ] as const) {
    test(title, async () => {
      const before = await owner.readPolicy(bucket);
      expect(await putPolicyAs(admin, [...getStoredStatements(), grant], before.etag)).toEqual({
        status: 403,
        code: 'RETENTION_GRANT_FORBIDDEN',
      });
      expect(await owner.readPolicy(bucket)).toEqual(before);
    });
  }

  test("P2. an admin may save a policy that keeps an owner's s3:* statement", async () => {
    const ownerAll = grantAllToOwner(ownerId);
    expect(await putPolicyAs(owner, [ownerAll], (await owner.readPolicy(bucket)).etag)).toEqual({
      status: 204,
      code: undefined,
    });
    const { etag } = await admin.readPolicy(bucket);
    const statement = [ownerAll, allow([memberId], ['s3:ListBucket'], 'team')];
    expect(await putPolicyAs(admin, statement, etag)).toEqual({ status: 204, code: undefined });
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
      toCanonicalPolicy({ Statement: statement }),
    );
  });

  test('P3. an owner grants the pair, and an admin may keep or drop it', async () => {
    const granted = allow([memberId], ['s3:PutObjectRetention', 's3:PutObjectLegalHold'], 'hold');
    const { etag } = await owner.readPolicy(bucket);
    expect(await putPolicyAs(owner, [...getStoredStatements(), granted], etag)).toEqual({
      status: 204,
      code: undefined,
    });

    const kept = [...getStoredStatements(), granted, allow([memberId], ['s3:ListBucket'], 'team')];
    expect(await putPolicyAs(admin, kept, (await admin.readPolicy(bucket)).etag)).toEqual({
      status: 204,
      code: undefined,
    });
    expect(
      await putPolicyAs(admin, getStoredStatements(), (await admin.readPolicy(bucket)).etag),
    ).toEqual({ status: 204, code: undefined });
    expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
      toCanonicalPolicy({ Statement: getStoredStatements() }),
    );
  });

  test('P4. an admin may deny the pair, since withholding is not granting', async () => {
    const statement = [
      ...getStoredStatements(),
      deny('*', ['s3:PutObjectRetention', 's3:PutObjectLegalHold'], 'no-holds'),
    ];
    expect(await putPolicyAs(admin, statement, (await admin.readPolicy(bucket)).etag)).toEqual({
      status: 204,
      code: undefined,
    });
  });

  test('P5. an admin writing a first policy may not grant s3:*, even to the owner', async () => {
    const { etag } = await owner.readPolicy(bucket);
    expect((await owner.deletePolicy(bucket, etag)).status()).toBe(204);

    expect(await putPolicyAs(admin, [grantAllToOwner(ownerId)])).toEqual({
      status: 403,
      code: 'RETENTION_GRANT_FORBIDDEN',
    });
    const statement = [allow([adminId], ['s3:ListBucket']), allow([memberId], ['s3:ListBucket'])];
    expect(await putPolicyAs(admin, statement)).toEqual({ status: 204, code: undefined });
  });

  test('P6. an admin may not name a retention write, even for the owner', async () => {
    const { etag } = await admin.readPolicy(bucket);
    const named = [
      ...getStoredStatements(),
      allow([ownerId], ['s3:PutObjectRetention'], 'owner-hold'),
    ];
    expect(await putPolicyAs(admin, named, etag)).toEqual({
      status: 403,
      code: 'RETENTION_GRANT_FORBIDDEN',
    });
  });

  test('P7. an admin writing without a precondition meets the same cap', async () => {
    const before = await owner.readPolicy(bucket);
    const res = await admin.putPolicy(bucket, {
      policy: {
        Statement: [...getStoredStatements(), allow([memberId], ['s3:PutObjectRetention'])],
      },
      unconditional: true,
    });
    expect({ status: res.status(), code: (await res.json()).code }).toEqual({
      status: 403,
      code: 'RETENTION_GRANT_FORBIDDEN',
    });
    expect(await owner.readPolicy(bucket)).toEqual(before);
  });
});

test.describe('in the editor', () => {
  // The Admin's tab acts in the Owner's org, which lives in sessionStorage.
  const openPolicyTab = async (page: Page) => {
    await page.addInitScript((id) => sessionStorage.setItem('filone:activeOrgId', id), orgId);
    await page.goto(`/buckets/${bucket}?region=${REGION}`);
    await page.getByTestId('bucket-policy-tab').click();
  };
  const modal = (page: Page) => page.getByTestId('policy-statement-modal');
  const actionRow = (page: Page, action: string) =>
    modal(page).getByTestId(`policy-action-${action}`);
  const PRIVILEGED_ROWS = ['all', 's3:PutObjectRetention', 's3:PutObjectLegalHold'];

  test.describe('as the admin', () => {
    test.use({ storageState: STORAGE_STATE.admin });

    test('PU1. the admin is not offered the privileged actions', async ({ page }) => {
      await openPolicyTab(page);
      await page.locator('#policy-add-statement-button').click();
      for (const action of PRIVILEGED_ROWS) await expect(actionRow(page, action)).toHaveCount(0);
      await expect(actionRow(page, 's3:GetObjectRetention')).toBeVisible();
    });

    test("PU2. the admin's edit keeps the owner's s3:* statement", async ({ page }) => {
      expect(
        await putPolicyAs(owner, [grantAllToOwner(ownerId)], (await owner.readPolicy(bucket)).etag),
      ).toEqual({ status: 204, code: undefined });
      const before = toCanonicalPolicy((await owner.readPolicy(bucket)).policy);
      await openPolicyTab(page);
      await chooseStatementMenuAction(page, 'owner-all', 'edit');
      // The editor keeps the `s3:*` the statement already carries, so the admin
      // may save it back unchanged; the save refuses only a grant that is new.
      await expect(actionRow(page, 'all').locator('[role="checkbox"]')).toBeChecked();
      await expect(actionRow(page, 's3:PutObjectRetention')).toHaveCount(0);
      await modal(page).locator('#policy-statement-submit-button').click();
      await page.locator('#policy-save-button').click();
      await expect(page.getByTestId('policy-save-bar')).toBeHidden();
      expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(before);
    });
  });

  test.describe('as the owner', () => {
    test.use({ storageState: STORAGE_STATE.owner });

    test('PU3. the owner grants a retention write from the editor', async ({ page }) => {
      await openPolicyTab(page);
      await page.locator('#policy-add-statement-button').click();
      for (const action of PRIVILEGED_ROWS) await expect(actionRow(page, action)).toBeVisible();
      await modal(page)
        .locator(`[data-testid="policy-principal-member"][data-user-id="${memberId}"]`)
        .click();
      await actionRow(page, 's3:PutObjectRetention').locator('[role="checkbox"]').click();
      await modal(page).locator('#policy-statement-submit-button').click();
      await page.locator('#policy-save-button').click();
      await expect(page.getByTestId('policy-save-bar')).toBeHidden();

      expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
        toCanonicalPolicy({
          Statement: [...getStoredStatements(), allow([memberId], ['s3:PutObjectRetention'])],
        }),
      );
    });
  });
});
