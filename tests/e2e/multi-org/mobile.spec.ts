import { test, expect } from './fixtures.ts';
import { homeOrgOf, resetToHomeOrg, userIdOf } from './org.util.ts';
import { readOrgName, seedMembership } from '../destructive/invite.util.ts';
import { STORAGE_STATE, byName, switcherNames } from './users.util.ts';

test.use({ storageState: STORAGE_STATE.member, viewport: { width: 390, height: 844 } });

let memberId: string;
let orgNames: string[];

test.beforeAll(async () => {
  const ownerId = await userIdOf('owner');
  memberId = await userIdOf('member');
  await resetToHomeOrg(memberId);
  const hostOrgId = await homeOrgOf(ownerId);
  await seedMembership({ orgId: hostOrgId, userId: memberId, role: 'member', invitedBy: ownerId });
  orgNames = await Promise.all([hostOrgId, await homeOrgOf(memberId)].map(readOrgName));
});

test.afterAll(async () => {
  await resetToHomeOrg(memberId);
});

test("the drawer's org menu opens the switcher", async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('#mobile-nav-toggle-button').click();
  await page.getByTestId('mobile-org-switcher-button').click();
  await expect(page.getByTestId('org-switcher')).toBeVisible();
  expect(await switcherNames(page)).toEqual(byName(orgNames));
});

test('the mobile user menu has Settings', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('#mobile-user-menu-button').click();
  await page.locator('[role="menu"] a[href="/settings"]').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('#settings-heading')).toBeVisible();
});
