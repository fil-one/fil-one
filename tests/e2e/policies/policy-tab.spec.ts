import { test, expect, type Page } from '@playwright/test';
import { resolvePersonalOrgId, runCleanup } from '../destructive/invite.util.ts';
import {
  allow,
  bindStatementToBucket,
  buildBucketPolicy,
  buildCreatorStatement,
  grantAllToOwner,
  chooseStatementMenuAction,
  createS3ClientWithNewKey,
  deny,
  emptyAndDeleteBucket,
  generateBucketName,
  getCredentials,
  getS3Outcome,
  listObjects,
  putObject,
  toCanonicalPolicy,
  ConsoleApi,
  REGION,
  STORAGE_STATE,
} from './policy.util.ts';

// The Policy tab, driven by the Owner. Every case gets its own bucket, and
// what the tab saved is read back through the console API and, where it
// changes access, through S3 with a key created after the save.

test.use({ storageState: STORAGE_STATE.owner });

const ownerId = getCredentials('owner').userId;
const memberId = getCredentials('member').userId;

let owner: ConsoleApi;
let member: ConsoleApi;
let bucket: string;
const createdKeys: { api: ConsoleApi; id: string }[] = [];

test.beforeAll(async () => {
  const orgId = await resolvePersonalOrgId(ownerId);
  owner = await ConsoleApi.open('owner', orgId);
  member = await ConsoleApi.open('member', orgId);
});

test.beforeEach(async () => {
  bucket = generateBucketName('tab');
  await owner.createBucket(bucket);
});

test.afterEach(async () => {
  const keys = createdKeys.splice(0).map(({ api, id }) => ({
    label: `key ${id}`,
    run: () => api.deleteKey(id),
  }));
  await runCleanup([
    { label: `bucket ${bucket}`, run: () => emptyAndDeleteBucket(owner, ownerId, bucket) },
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
const card = (page: Page, title: string) =>
  page.locator(`[data-testid="policy-statement"][data-statement-title="${title}"]`);
const modal = (page: Page) => page.getByTestId('policy-statement-modal');
const nameInput = (page: Page) => modal(page).locator('#policy-statement-name');
const submit = (page: Page) => modal(page).locator('#policy-statement-submit-button');
const saveBar = (page: Page) => page.getByTestId('policy-save-bar');
const emptyState = (page: Page) => page.getByTestId('policy-empty');
const memberBox = (page: Page, userId: string) =>
  modal(page).locator(`[data-testid="policy-principal-member"][data-user-id="${userId}"]`);
// The row is a <label> around a Headless UI <span role="checkbox">, which a
// label cannot target, so the box itself is what toggles.
const actionBox = (page: Page, action: string) =>
  modal(page).getByTestId(`policy-action-${action}`).locator('[role="checkbox"]');

async function openAddStatement(page: Page): Promise<void> {
  await page.locator('#policy-add-statement-button').click();
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

test('the tab lists the creator statement of a new bucket', async ({ page }) => {
  await openPolicyTab(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'creator')).toBeVisible();
});

test('the creator statement can be renamed like any other', async ({ page }) => {
  await openPolicyTab(page);
  await chooseStatementMenuAction(page, 'creator', 'edit');
  await expect(nameInput(page)).toBeEnabled();
  await expect(nameInput(page)).toHaveValue('creator');
  await nameInput(page).fill('owner-all');
  await submitStatement(page);
  await savePolicy(page);
  expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
    toCanonicalPolicy(
      buildBucketPolicy(bucket, [{ ...buildCreatorStatement(ownerId), Sid: 'owner-all' }]),
    ),
  );
});

test('an allow added in the tab grants the member', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await nameInput(page).fill('member-read');
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:ListBucket', 's3:GetObject']);
  await submitStatement(page);
  await expect(cards(page)).toHaveCount(2);
  await expect(saveBar(page)).toBeVisible();
  await savePolicy(page);

  expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
    toCanonicalPolicy(
      buildBucketPolicy(bucket, [
        buildCreatorStatement(ownerId),
        allow([memberId], ['s3:ListBucket', 's3:GetObject'], 'member-read'),
      ]),
    ),
  );
  expect(
    await getS3Outcome(listObjects(await createS3ClientWithNewKey(member, createdKeys), bucket)),
  ).toBe('ok');
});

test('editing a statement widens the grant', async ({ page }) => {
  await owner.replaceStatements(bucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:ListBucket'], 'member-read'),
  ]);
  await openPolicyTab(page);
  await chooseStatementMenuAction(page, 'member-read', 'edit');
  await pickActions(page, ['s3:PutObject']);
  await submitStatement(page);
  await savePolicy(page);

  expect(
    (await owner.readPolicy(bucket)).policy.Statement.find((st) => st.Sid === 'member-read'),
  ).toEqual(
    bindStatementToBucket(
      bucket,
      allow([memberId], ['s3:ListBucket', 's3:PutObject'], 'member-read'),
    ),
  );
  expect(
    await getS3Outcome(
      putObject(await createS3ClientWithNewKey(member, createdKeys), bucket, 'member-write.txt'),
    ),
  ).toBe('ok');
});

test('removing a statement takes its grant away', async ({ page }) => {
  await owner.replaceStatements(bucket, [
    grantAllToOwner(ownerId),
    allow([memberId], ['s3:ListBucket'], 'member-read'),
  ]);
  await openPolicyTab(page);
  await chooseStatementMenuAction(page, 'member-read', 'remove');
  await expect(cards(page)).toHaveCount(1);
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy).toEqual(
    buildBucketPolicy(bucket, [grantAllToOwner(ownerId)]),
  );
  expect(
    await getS3Outcome(listObjects(await createS3ClientWithNewKey(member, createdKeys), bucket)),
  ).toBe('404 NoSuchBucket');
});

test('a deny for everyone warns, locks the owner out, and can be undone', async ({ page }) => {
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

  expect(
    (await owner.readPolicy(bucket)).policy.Statement.find((st) => st.Sid === 'lockdown'),
  ).toEqual(bindStatementToBucket(bucket, deny('*', ['s3:*'], 'lockdown')));
  expect(
    await getS3Outcome(listObjects(await createS3ClientWithNewKey(owner, createdKeys), bucket)),
  ).toBe('404 NoSuchBucket');

  await chooseStatementMenuAction(page, 'lockdown', 'remove');
  await expect(page.getByTestId('policy-denies-everyone')).toBeHidden();
  await savePolicy(page);
  expect(
    await getS3Outcome(listObjects(await createS3ClientWithNewKey(owner, createdKeys), bucket)),
  ).toBe('ok');
});

test('a statement may take a name starting with filone-', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await nameInput(page).fill('filone-x');
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:ListBucket']);
  await expect(submit(page)).toBeEnabled();
  await submitStatement(page);
  await savePolicy(page);

  expect(
    (await owner.readPolicy(bucket)).policy.Statement.find((st) => st.Sid === 'filone-x'),
  ).toEqual(bindStatementToBucket(bucket, allow([memberId], ['s3:ListBucket'], 'filone-x')));
});

test('a statement needs a principal and an action', async ({ page }) => {
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

test('all actions covers every action and saves as s3:*', async ({ page }) => {
  await openPolicyTab(page);
  await openAddStatement(page);
  await memberBox(page, memberId).click();
  await actionBox(page, 'all').click();
  await expect(actionBox(page, 's3:GetObject')).toBeDisabled();
  await expect(actionBox(page, 's3:GetObject')).toBeChecked();
  await submitStatement(page);
  await savePolicy(page);

  // The stored order is the storage system's own; the new statement is the
  // unnamed one.
  expect((await owner.readPolicy(bucket)).policy.Statement.find((st) => !st.Sid)).toEqual(
    bindStatementToBucket(bucket, allow([memberId], ['s3:*'])),
  );
});

test('a cancelled statement writes nothing', async ({ page }) => {
  const { etag } = await owner.readPolicy(bucket);
  await openPolicyTab(page);
  await openAddStatement(page);
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:GetObject']);
  await modal(page).locator('#policy-statement-cancel-button').click();
  await expect(cards(page)).toHaveCount(1);
  await expect(saveBar(page)).toBeHidden();
  expect((await owner.readPolicy(bucket)).etag).toBe(etag);
});

test('a discarded edit writes nothing', async ({ page }) => {
  const { etag } = await owner.readPolicy(bucket);
  await openPolicyTab(page);
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

test("a save after another writer's change shows the conflict, and reload shows their policy", async ({
  page,
}) => {
  await openPolicyTab(page);
  await expect(cards(page)).toHaveCount(1);
  const theirs = [grantAllToOwner(ownerId), allow([memberId], ['s3:ListBucket'], 'theirs')];
  await owner.replaceStatements(bucket, theirs);

  await openAddStatement(page);
  await memberBox(page, memberId).click();
  await pickActions(page, ['s3:GetObject']);
  await submitStatement(page);
  await page.locator('#policy-save-button').click();
  await expect(page.getByTestId('policy-conflict')).toBeVisible();
  expect(toCanonicalPolicy((await owner.readPolicy(bucket)).policy)).toEqual(
    toCanonicalPolicy(buildBucketPolicy(bucket, theirs)),
  );

  await page.locator('#policy-reload-button').click();
  await expect(page.getByTestId('policy-conflict')).toBeHidden();
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, 'theirs')).toBeVisible();
});

test('removing the policy leaves the empty state', async ({ page }) => {
  await openPolicyTab(page);
  await page.locator('#policy-remove-button').click();
  await page.locator('#confirm-dialog-confirm-button').click();
  await expectToast(page, 'Policy removed');
  await expect(emptyState(page)).toHaveAttribute('data-empty-state', 'no-policy');
  const res = await owner.fetchPolicyResponse(bucket);
  expect([res.status(), (await res.json()).code]).toEqual([404, 'POLICY_NOT_FOUND']);
});

test('the first statement on a bucket with no policy creates one', async ({ page }) => {
  const { etag } = await owner.readPolicy(bucket);
  expect((await owner.deletePolicy(bucket, etag)).status()).toBe(204);
  await openPolicyTab(page);
  await expect(emptyState(page)).toHaveAttribute('data-empty-state', 'no-policy');

  await page.locator('#policy-empty-add-statement-button').click();
  await memberBox(page, ownerId).click();
  await actionBox(page, 'all').click();
  await submitStatement(page);
  await savePolicy(page);

  expect((await owner.readPolicy(bucket)).policy).toEqual(
    buildBucketPolicy(bucket, [allow([ownerId], ['s3:*'])]),
  );
});
