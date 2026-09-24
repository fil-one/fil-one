import { test, expect, type Page } from '@playwright/test';
import type { PolicyStatement } from '@filone/shared';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  REGION,
  STORAGE_STATE,
  adminsStatement,
  allow,
  credentials,
  deny,
  ownersStatement,
  removeBucket,
  rosterPolicy,
  uniqueBucketName,
} from './policy.util.ts';

// Granting a retention or legal-hold write is `privileged.grant`, which only an
// Owner holds: `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, and `s3:*`,
// which stands for both. An Admin manages policies but may not newly grant the
// pair; a grant the stored policy already makes is not new.

const ownerId = credentials('owner').userId;
const adminId = credentials('admin').userId;
const memberId = credentials('member').userId;

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
  bucket = uniqueBucketName('priv');
  await owner.createBucket(bucket);
});

test.afterEach(async () => {
  await runCleanup([
    { label: `bucket ${bucket}`, run: () => removeBucket(owner, ownerId, bucket) },
  ]);
});

test.afterAll(async () => {
  await owner.dispose();
  await admin.dispose();
});

const roster = () => rosterPolicy(ownerId, adminId).statement;

async function putAs(api: ConsoleApi, statement: PolicyStatement[], etag?: string) {
  const res = await api.putPolicy(bucket, { policy: { statement }, etag });
  return [res.status(), ((await res.json()) as { code?: string }).code];
}

test.describe('through the API', () => {
  test('P1. an admin cannot newly grant a retention or legal-hold write', async () => {
    const before = await owner.readPolicy(bucket);
    const outcomes = [];
    for (const grant of [
      allow([memberId], ['s3:PutObjectRetention']),
      allow([memberId], ['s3:PutObjectLegalHold']),
      allow([memberId], ['s3:*']),
      allow('*', ['s3:PutObjectLegalHold']),
      allow([adminId], ['s3:PutObjectRetention']),
    ]) {
      outcomes.push(await putAs(admin, [...roster(), grant], before.etag));
    }
    expect(outcomes).toEqual(Array(5).fill([403, 'RETENTION_GRANT_FORBIDDEN']));
    expect(await owner.readPolicy(bucket)).toEqual(before);
  });

  test('P2. an admin edits freely around the grants the owners already hold', async () => {
    const { etag } = await admin.readPolicy(bucket);
    const statement = [...roster(), allow([memberId], ['s3:ListBucket'], 'team')];
    expect(await putAs(admin, statement, etag)).toEqual([200, undefined]);
    expect((await owner.readPolicy(bucket)).policy).toEqual({ statement });
  });

  test('P3. an owner grants the pair, and an admin may keep or drop it', async () => {
    const granted = allow([memberId], ['s3:PutObjectRetention', 's3:PutObjectLegalHold'], 'hold');
    const { etag } = await owner.readPolicy(bucket);
    expect(await putAs(owner, [...roster(), granted], etag)).toEqual([200, undefined]);

    const kept = [...roster(), granted, allow([memberId], ['s3:ListBucket'], 'team')];
    expect(await putAs(admin, kept, (await admin.readPolicy(bucket)).etag)).toEqual([
      200,
      undefined,
    ]);
    expect(await putAs(admin, roster(), (await admin.readPolicy(bucket)).etag)).toEqual([
      200,
      undefined,
    ]);
    expect((await owner.readPolicy(bucket)).policy).toEqual({ statement: roster() });
  });

  test('P4. an admin may deny the pair, since withholding is not granting', async () => {
    const statement = [
      ...roster(),
      deny('*', ['s3:PutObjectRetention', 's3:PutObjectLegalHold'], 'no-holds'),
    ];
    expect(await putAs(admin, statement, (await admin.readPolicy(bucket)).etag)).toEqual([
      200,
      undefined,
    ]);
  });

  test('P5. an admin writing a first policy may not grant the pair either', async () => {
    const { etag } = await owner.readPolicy(bucket);
    expect((await owner.deletePolicy(bucket, etag)).status()).toBe(204);

    expect(await putAs(admin, [ownersStatement(ownerId)])).toEqual([
      403,
      'RETENTION_GRANT_FORBIDDEN',
    ]);
    const statement = [adminsStatement(adminId), allow([memberId], ['s3:ListBucket'])];
    expect(await putAs(admin, statement)).toEqual([201, undefined]);
  });
});

test.describe('in the editor', () => {
  // The Admin's tab acts in the Owner's org, which lives in sessionStorage.
  const openAs = async (page: Page) => {
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
      await openAs(page);
      await page.locator('#policy-add-statement').click();
      for (const action of PRIVILEGED_ROWS) await expect(actionRow(page, action)).toHaveCount(0);
      await expect(actionRow(page, 's3:GetObjectRetention')).toBeVisible();
    });

    test('PU2. the admin cannot save the owners statement back', async ({ page }) => {
      const { etag } = await owner.readPolicy(bucket);
      await openAs(page);
      await page
        .locator('[data-testid="policy-statement"][data-statement-label="Owners"]')
        .getByTestId('policy-statement-edit')
        .click();
      // `s3:*` is pruned from what the admin may offer, leaving no action.
      await expect(modal(page).locator('#policy-statement-submit')).toBeDisabled();
      await modal(page).locator('#policy-statement-cancel').click();
      await expect(page.getByTestId('policy-save-bar')).toBeHidden();
      expect((await owner.readPolicy(bucket)).etag).toBe(etag);
    });
  });

  test.describe('as the owner', () => {
    test.use({ storageState: STORAGE_STATE.owner });

    test('PU3. the owner grants a retention write from the editor', async ({ page }) => {
      await openAs(page);
      await page.locator('#policy-add-statement').click();
      for (const action of PRIVILEGED_ROWS) await expect(actionRow(page, action)).toBeVisible();
      await modal(page)
        .locator(`[data-testid="policy-principal-member"][data-user-id="${memberId}"]`)
        .click();
      await actionRow(page, 's3:PutObjectRetention').locator('[role="checkbox"]').click();
      await modal(page).locator('#policy-statement-submit').click();
      await page.locator('#policy-save-button').click();
      await expect(page.getByTestId('policy-save-bar')).toBeHidden();

      expect((await owner.readPolicy(bucket)).policy).toEqual({
        statement: [...roster(), allow([memberId], ['s3:PutObjectRetention'])],
      });
    });
  });
});
