import { test, expect } from './fixtures.ts';
import { homeOrgOf, resetToHomeOrg, setOrgName, userIdOf } from './org.util.ts';
import { readOrgName } from '../destructive/invite.util.ts';
import { STORAGE_STATE, menuItem } from './users.util.ts';

test.use({ storageState: STORAGE_STATE.owner });

let orgId: string;
let orgName: string;

test.beforeAll(async () => {
  const ownerId = await userIdOf('owner');
  await resetToHomeOrg(ownerId);
  orgId = await homeOrgOf(ownerId);
  orgName = await readOrgName(orgId);
});

test.afterAll(async () => {
  await setOrgName(orgId, { name: orgName });
});

for (const { item, path, heading } of [
  { item: 'Members', path: '/members', heading: 'Members' },
  { item: 'Billing', path: '/billing', heading: 'Billing' },
  { item: 'Audit log', path: '/audit', heading: 'Audit log' },
  { item: 'Edit organization', path: '/edit-organization', heading: 'Edit organization' },
]) {
  test(`${item} opens from the org menu`, async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('org-switcher-button').click();
    await menuItem(page, item).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator('h1', { hasText: heading })).toBeVisible();
  });
}

test('/organization redirects to /members', async ({ page }) => {
  await page.goto('/organization');
  await expect(page).toHaveURL(/\/members$/);
  await expect(page.locator('#members-heading')).toBeVisible();
});

test('renaming the organization updates the switcher', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('org-switcher-button').click();
  await page.getByTestId('org-menu-edit').click();
  await expect(page).toHaveURL(/\/edit-organization$/);

  const rename = async (name: string) => {
    await page.locator('#org-name').fill(name);
    await page.locator('button', { hasText: /^Save$/ }).click();
    await expect(page.getByTestId('org-switcher-button')).toContainText(name);
  };
  await rename('E2E Renamed Org');
  await rename(orgName);
});
