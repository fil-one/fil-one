import { test, expect, api } from './fixtures.ts';
import { homeOrgOf, resetToHomeOrg, userIdOf } from './org.util.ts';
import { readOrgName, seedMembership } from '../destructive/invite.util.ts';
import { STORAGE_STATE, billingGate, switchTo } from './users.util.ts';

const UNPAID_ORG = 'Acme Unpaid Org';

test.describe.configure({ mode: 'serial' });

let ownerId: string;
let memberId: string;
let homeOrgName: string;

test.beforeAll(async ({ browser }) => {
  [ownerId, memberId] = await Promise.all([userIdOf('owner'), userIdOf('member')]);
  await Promise.all([resetToHomeOrg(ownerId), resetToHomeOrg(memberId)]);
  homeOrgName = await readOrgName(await homeOrgOf(ownerId));

  // The owner's trial went to their first org, so this one has no plan.
  const page = await browser.newPage({
    storageState: STORAGE_STATE.owner,
    ignoreHTTPSErrors: true,
  });
  const created = await api(page, 'POST', '/api/org', { name: UNPAID_ORG });
  expect(created.status()).toBe(201);
  const { orgId } = await created.json();
  await page.close();
  await seedMembership({ orgId, userId: memberId, role: 'member', invitedBy: ownerId });
});

test.afterAll(async () => {
  await Promise.all([resetToHomeOrg(ownerId), resetToHomeOrg(memberId)]);
});

test.describe('owner', () => {
  test.use({ storageState: STORAGE_STATE.owner });

  test('an org without a plan is gated, its setup pages are not', async ({ page }) => {
    await page.goto('/dashboard');
    await switchTo(page, UNPAID_ORG);

    for (const path of ['/dashboard', '/buckets']) {
      await page.goto(path);
      await expect(billingGate(page)).toBeVisible();
      await expect(page.getByTestId('nav-dashboard')).toHaveCount(0);
      await expect(page.getByTestId('nav-buckets')).toHaveCount(0);
    }

    await page.goto('/settings');
    await expect(page.locator('#settings-heading')).toBeVisible();
    await expect(billingGate(page)).toBeHidden();

    await page.goto('/edit-organization');
    await expect(page.locator('#org-name')).toHaveValue(UNPAID_ORG);
    await expect(billingGate(page)).toBeHidden();
  });

  test('switching back to the org with a plan clears the gate', async ({ page }) => {
    await page.goto('/dashboard');
    await switchTo(page, UNPAID_ORG);
    await expect(billingGate(page)).toBeVisible();

    await switchTo(page, homeOrgName);
    await expect(page.locator('#dashboard-heading')).toBeVisible();
    await expect(billingGate(page)).toBeHidden();
    await expect(page.getByTestId('nav-buckets')).toBeVisible();
  });
});

test.describe('member', () => {
  test.use({ storageState: STORAGE_STATE.member });

  test('a Member is told to ask an Owner', async ({ page }) => {
    await page.goto('/dashboard');
    await switchTo(page, UNPAID_ORG);
    await expect(billingGate(page)).toContainText('Ask an Owner to add a payment method.');
  });
});
