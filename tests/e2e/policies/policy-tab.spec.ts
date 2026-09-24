import { test, expect, type Page } from '@playwright/test';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  ConsoleApi,
  REGION,
  STORAGE_STATE,
  allow,
  credentials,
  deny,
  listObjects,
  outcome,
  ownersStatement,
  putObject,
  removeBucket,
  s3For,
  uniqueBucketName,
} from './policy.util.ts';

// The Policy tab, driven by the Owner. Every case gets its own bucket, and
// what the tab saved is read back through the console API and, where it
// changes access, through S3 with a key minted after the save.

test.use({ storageState: STORAGE_STATE.owner });

const ownerId = credentials('owner').userId;
const memberId = credentials('member').userId;

let owner: ConsoleApi;
let member: ConsoleApi;
let bucket: string;
const minted: { api: ConsoleApi; id: string }[] = [];

async function freshS3(api: ConsoleApi) {
  const key = await api.mintKey();
  minted.push({ api, id: key.id });
  return s3For(key);
}

test.beforeAll(async () => {
  const orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  member = await ConsoleApi.open('member', orgId);
});

test.beforeEach(async () => {
  bucket = uniqueBucketName('tab');
  await owner.createBucket(bucket);
});

test.afterEach(async () => {
  const keys = minted.splice(0).map(({ api, id }) => ({
    label: `key ${id}`,
    run: () => api.deleteKey(id),
  }));
  await runCleanup([
    { label: `bucket ${bucket}`, run: () => removeBucket(owner, ownerId, bucket) },
    ...keys,
  ]);
});

test.afterAll(async () => {
  await owner.dispose();
  await member.dispose();
});

async function openPolicyTab(page: Page): Promise<void> {
  await page.goto(`/buckets/${bucket}?region=${REGION}`);
  await page.getByTestId('bucket-policy-tab').click();
}

const cards = (page: Page) => page.getByTestId('policy-statement');
const card = (page: Page, label: string) =>
  page.locator(`[data-testid="policy-statement"][data-statement-label="${label}"]`);
const modal = (page: Page) => page.getByTestId('policy-statement-modal');
const nameInput = (page: Page) => modal(page).locator('#policy-statement-name');
const submit = (page: Page) => modal(page).locator('#policy-statement-submit');
const saveBar = (page: Page) => page.getByTestId('policy-save-bar');
const emptyState = (page: Page) => page.getByTestId('policy-empty');
const memberBox = (page: Page, userId: string) =>
  modal(page).locator(`[data-testid="policy-principal-member"][data-user-id="${userId}"]`);
// The row is a <label> around a Headless UI <span role="checkbox">, which a
// label cannot target, so the box itself is what toggles.
const actionBox = (page: Page, action: string) =>
  modal(page).getByTestId(`policy-action-${action}`).locator('[role="checkbox"]');

async function openAddStatement(page: Page): Promise<void> {
  await page.locator('#policy-add-statement').click();
  await expect(modal(page)).toBeVisible();
}

async function pickActions(page: Page, actions: string[]): Promise<void> {
  for (const action of actions) await actionBox(page, action).click();
}

async function submitStatement(page: Page): Promise<void> {
  await submit(page).click();
  await expect(modal(page)).toBeHidden();
}

async function expectToast(page: Page, message: string): Promise<void> {
  await expect(page.locator('[data-testid="toast"][data-toast-variant="success"]')).toContainText(
    message,
  );
}

async function savePolicy(page: Page): Promise<void> {
  await page.locator('#policy-save-button').click();
  await expectToast(page, 'Policy saved');
  await expect(saveBar(page)).toBeHidden();
}

test('U1. the tab lists the owners statement of a new bucket', async ({ page }) => {
  await openPolicyTab(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'Owners')).toBeVisible();
});

test('U2. a roster statement keeps its name but can be removed', async ({ page }) => {
  await openPolicyTab(page);
  await card(page, 'Owners').getByTestId('policy-statement-edit').click();
  await expect(nameInput(page)).toBeDisabled();
  await expect(nameInput(page)).toHaveValue('Owners');
  await modal(page).locator('#policy-statement-cancel').click();

  await card(page, 'Owners').getByTestId('policy-statement-remove').click();
  await expect(emptyState(page)).toHaveAttribute('data-empty-state', 'cleared');
  await page.locator('#policy-save-button').click();
  await expectToast(page, 'Policy removed');
  const res = await owner.getPolicy(bucket);
  expect([res.status(), (await res.json()).code]).toEqual([404, 'POLICY_NOT_FOUND']);
});

test('U3. an allow added in the tab grants the member', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await nameInput(page).fill('member-read');
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:ListBucket', 's3:GetObject']);
  await submitStatement(page);
  await expect(cards(page)).toHaveCount(2);
  await expect(saveBar(page)).toBeVisible();
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy).toEqual({
    statement: [
      ownersStatement(ownerId),
      allow([memberId], ['s3:ListBucket', 's3:GetObject'], 'member-read'),
    ],
  });
  expect(await outcome(listObjects(await freshS3(member), bucket))).toBe('ok');
});

test('U4. editing a statement widens the grant', async ({ page }) => {
  await owner.setStatements(bucket, [
    ownersStatement(ownerId),
    allow([memberId], ['s3:ListBucket'], 'member-read'),
  ]);
  await openPolicyTab(page);
  await card(page, 'member-read').getByTestId('policy-statement-edit').click();
  await pickActions(page, ['s3:PutObject']);
  await submitStatement(page);
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy.statement[1]).toEqual(
    allow([memberId], ['s3:ListBucket', 's3:PutObject'], 'member-read'),
  );
  expect(await outcome(putObject(await freshS3(member), bucket, 'member-write.txt'))).toBe('ok');
});

test('U5. removing a statement takes its grant away', async ({ page }) => {
  await owner.setStatements(bucket, [
    ownersStatement(ownerId),
    allow([memberId], ['s3:ListBucket'], 'member-read'),
  ]);
  await openPolicyTab(page);
  await card(page, 'member-read').getByTestId('policy-statement-remove').click();
  await expect(cards(page)).toHaveCount(1);
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy).toEqual({
    statement: [ownersStatement(ownerId)],
  });
  expect(await outcome(listObjects(await freshS3(member), bucket))).toBe('404 NoSuchBucket');
});

test('U6. a deny for everyone warns, locks the owner out, and can be undone', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await nameInput(page).fill('lockdown');
  await modal(page).getByTestId('policy-effect-deny').click();
  await modal(page).getByTestId('policy-principal-everyone').click();
  await expect(modal(page).getByTestId('policy-statement-denies-everyone')).toBeVisible();
  await actionBox(page, 'all').click();
  await submitStatement(page);
  await expect(page.getByTestId('policy-denies-everyone')).toBeVisible();
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy.statement[1]).toEqual(
    deny('*', ['s3:*'], 'lockdown'),
  );
  expect(await outcome(listObjects(await freshS3(owner), bucket))).toBe('404 NoSuchBucket');

  await card(page, 'lockdown').getByTestId('policy-statement-remove').click();
  await expect(page.getByTestId('policy-denies-everyone')).toBeHidden();
  await savePolicy(page);
  expect(await outcome(listObjects(await freshS3(owner), bucket))).toBe('ok');
});

test('U7. a statement may take a name starting with filone-', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await nameInput(page).fill('filone-x');
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:ListBucket']);
  await expect(submit(page)).toBeEnabled();
  await submitStatement(page);
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy.statement[1]).toEqual(
    allow([memberId], ['s3:ListBucket'], 'filone-x'),
  );
});

test('U8. a statement needs a principal and an action', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await expect(submit(page)).toBeDisabled();
  await memberBox(page, memberId).click();
  await expect(submit(page)).toBeDisabled();
  await pickActions(page, ['s3:GetObject']);
  await expect(submit(page)).toBeEnabled();
  await memberBox(page, memberId).click();
  await expect(submit(page)).toBeDisabled();
});

test('U9. all actions covers every action and saves as s3:*', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await memberBox(page, memberId).click();
  await actionBox(page, 'all').click();
  await expect(actionBox(page, 's3:GetObject')).toBeDisabled();
  await expect(actionBox(page, 's3:GetObject')).toBeChecked();
  await submitStatement(page);
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy.statement[1]).toEqual(allow([memberId], ['s3:*']));
});

test('U10. a cancelled or discarded edit writes nothing', async ({ page }) => {
  const { etag } = await owner.readPolicy(bucket);
  await openPolicyTab(page);

  await openAddStatement(page);
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:GetObject']);
  await modal(page).locator('#policy-statement-cancel').click();
  await expect(cards(page)).toHaveCount(1);
  await expect(saveBar(page)).toBeHidden();

  await openAddStatement(page);
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:GetObject']);
  await submitStatement(page);
  await expect(cards(page)).toHaveCount(2);
  await page.locator('#policy-discard-button').click();
  await expect(cards(page)).toHaveCount(1);
  await expect(saveBar(page)).toBeHidden();

  expect((await owner.readPolicy(bucket)).etag).toBe(etag);
});

test('U11. a save that lost to another writer shows the conflict and reloads', async ({ page }) => {
  await openPolicyTab(page);
  await expect(cards(page)).toHaveCount(1);
  const theirs = [ownersStatement(ownerId), allow([memberId], ['s3:ListBucket'], 'theirs')];
  await owner.setStatements(bucket, theirs);

  await openAddStatement(page);
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:GetObject']);
  await submitStatement(page);
  await page.locator('#policy-save-button').click();
  await expect(page.getByTestId('policy-conflict')).toBeVisible();
  expect((await owner.readPolicy(bucket)).policy).toEqual({ statement: theirs });

  await page.locator('#policy-reload-button').click();
  await expect(page.getByTestId('policy-conflict')).toBeHidden();
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, 'theirs')).toBeVisible();
});

test('U12. removing the policy leaves the empty state', async ({ page }) => {
  await openPolicyTab(page);
  await page.locator('#policy-remove-button').click();
  await page.locator('#confirm-dialog-confirm-button').click();
  await expectToast(page, 'Policy removed');
  await expect(emptyState(page)).toHaveAttribute('data-empty-state', 'none');
  const res = await owner.getPolicy(bucket);
  expect([res.status(), (await res.json()).code]).toEqual([404, 'POLICY_NOT_FOUND']);
});

test('U13. the first statement on a bucket with no policy creates one', async ({ page }) => {
  const { etag } = await owner.readPolicy(bucket);
  expect((await owner.deletePolicy(bucket, etag)).status()).toBe(204);
  await openPolicyTab(page);
  await expect(emptyState(page)).toHaveAttribute('data-empty-state', 'none');

  await page.locator('#policy-empty-add-statement').click();
  await memberBox(page, ownerId).click();
  await actionBox(page, 'all').click();
  await submitStatement(page);
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy).toEqual({
    statement: [allow([ownerId], ['s3:*'])],
  });
});
