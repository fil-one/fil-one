import { test, expect } from './fixtures.ts';
import { homeOrgOf, resetToHomeOrg, setOrgName, userIdOf } from './org.util.ts';
import { STORAGE_STATE, logIn } from './users.util.ts';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const userId = await userIdOf('fresh');
  await resetToHomeOrg(userId);
  await setOrgName(await homeOrgOf(userId), { nameConfirmed: false });
});

test.describe('signing in', () => {
  test('a first login lands on /create-organization', async ({ page }) => {
    await logIn(page, 'fresh');
    await expect(page).toHaveURL(/\/create-organization$/);
    await expect(page.locator('#welcome-org-name')).not.toHaveValue('');
  });
});

test.describe('fresh user', () => {
  test.use({ storageState: STORAGE_STATE.fresh });

  test('naming the organization lands on /get-started', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/create-organization$/);
    await page.locator('#welcome-org-name').fill('E2E Fresh Org');
    await page.locator('#welcome-org-name').press('Enter');
    await expect(page).toHaveURL(/\/get-started$/);
  });

  test('a named organization is sent away from /create-organization', async ({ page }) => {
    await page.goto('/create-organization');
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
