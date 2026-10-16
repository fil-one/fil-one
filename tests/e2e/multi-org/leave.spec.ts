import { test, expect, type Page } from './fixtures.ts';
import {
  deleteOrg,
  homeOrgOf,
  resetToHomeOrg,
  restoreHomeOrg,
  setHomeOrg,
  userIdOf,
} from './org.util.ts';
import {
  deleteMembership,
  readOrgName,
  runCleanup,
  seedMembership,
} from '../destructive/invite.util.ts';
import { STORAGE_STATE, byName, menuItem, switchTo, switcherNames } from './users.util.ts';

test.describe.configure({ mode: 'serial' });
test.use({ storageState: STORAGE_STATE.member });

let memberId: string;
let ownerId: string;
const orgs = { member: '', owner: '', fresh: '' };
const names = { member: '', owner: '', fresh: '' };

test.beforeAll(async () => {
  let freshId: string;
  [memberId, ownerId, freshId] = await Promise.all([
    userIdOf('member'),
    userIdOf('owner'),
    userIdOf('fresh'),
  ]);
  await resetToHomeOrg(memberId);
  [orgs.member, orgs.owner, orgs.fresh] = await Promise.all(
    [memberId, ownerId, freshId].map(homeOrgOf),
  );
  [names.member, names.owner, names.fresh] = await Promise.all(
    [orgs.member, orgs.owner, orgs.fresh].map(readOrgName),
  );
  for (const [orgId, invitedBy] of [
    [orgs.owner, ownerId],
    [orgs.fresh, freshId],
  ]) {
    await seedMembership({ orgId, userId: memberId, role: 'member', invitedBy });
  }
});

test.afterAll(async () => {
  const floorOrg = await homeOrgOf(memberId);
  await runCleanup([
    {
      label: 'floor org',
      run: async () => floorOrg !== orgs.member && floorOrg !== orgs.owner && deleteOrg(floorOrg),
    },
    { label: 'home org', run: () => restoreHomeOrg('member', memberId, orgs.member) },
    { label: 'other memberships', run: () => resetToHomeOrg(memberId) },
  ]);
});

async function leave(page: Page, orgName: string) {
  await page.goto('/settings');
  await page.locator(`button[aria-label="Actions for ${orgName}"]`).click();
  await menuItem(page, 'Leave organization').click();
}

test('a member leaves an organization, and it leaves the switcher', async ({ page }) => {
  await page.goto('/dashboard');
  await switchTo(page, names.owner);
  await leave(page, names.owner);
  await page.locator('#confirm-dialog-confirm-button').click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByTestId('org-switcher-button').click();
  await expect(page.getByTestId('org-switcher')).toBeVisible();
  expect(await switcherNames(page)).toEqual(byName([names.member, names.fresh]));
});

test('the last owner cannot leave', async ({ page }) => {
  await leave(page, names.member);
  await expect(page.locator('#confirm-dialog-confirm-button')).toBeDisabled();
});

test('leaving the last org lands on /left-organization, which starts naming', async ({ page }) => {
  // Only a Member of one org: out of their own and the fresh org, home pointed at the owner's.
  await seedMembership({ orgId: orgs.owner, userId: memberId, role: 'member', invitedBy: ownerId });
  await deleteMembership({ orgId: orgs.fresh, userId: memberId });
  await deleteMembership({ orgId: orgs.member, userId: memberId });
  await setHomeOrg('member', memberId, orgs.owner);

  await leave(page, names.owner);
  await page.locator('#confirm-dialog-confirm-button').click();

  await expect(page).toHaveURL(/\/left-organization$/);
  await page.locator('a[href="/create-organization"]').click();
  await expect(page).toHaveURL(/\/create-organization$/);
  await expect(page.locator('#welcome-org-name')).toBeVisible();
});
