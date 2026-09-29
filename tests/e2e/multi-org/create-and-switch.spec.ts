import { test, expect } from './fixtures.ts';
import { homeOrgOf, resetToHomeOrg, userIdOf } from './org.util.ts';
import { readOrgName } from '../destructive/invite.util.ts';
import {
  STORAGE_STATE,
  billingGate,
  byName,
  menuItem,
  switchTo,
  switcherNames,
} from './users.util.ts';

const SECOND_ORG = 'Acme Second Org';

test.describe.configure({ mode: 'serial' });
test.use({ storageState: STORAGE_STATE.owner });

let ownerId: string;
let homeOrgName: string;

test.beforeAll(async () => {
  ownerId = await userIdOf('owner');
  await resetToHomeOrg(ownerId);
  homeOrgName = await readOrgName(await homeOrgOf(ownerId));
});

test.afterAll(async () => {
  await resetToHomeOrg(ownerId);
});

test('creating an organization from the menu lands on its /get-started', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('org-switcher-button').click();
  await menuItem(page, 'Create organization').click();
  await expect(page.getByTestId('create-organization-dialog')).toBeVisible();
  await page.locator('#create-org-name').fill(SECOND_ORG);
  await page.locator('#create-org-save-button').click();

  await expect(page).toHaveURL(/\/get-started$/);
  await expect(page.getByTestId('org-switcher-button')).toContainText(SECOND_ORG);
});

test('the switcher lists both organizations by name, the active one current', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('org-switcher-button').click();

  expect(await switcherNames(page)).toEqual(byName([homeOrgName, SECOND_ORG]));
  await expect(page.getByTestId('org-switcher').locator('button[aria-current]')).toContainText(
    homeOrgName,
  );
});

test('switching happens in place and shows the new organization', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('#dashboard-heading')).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));

  // The second org has no plan, so its dashboard is the billing gate.
  await switchTo(page, SECOND_ORG);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(billingGate(page)).toBeVisible();
  await expect(page.locator('#dashboard-heading')).toBeHidden();

  await switchTo(page, homeOrgName);
  await expect(page.locator('#dashboard-heading')).toBeVisible();
  await expect(billingGate(page)).toBeHidden();

  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
});
