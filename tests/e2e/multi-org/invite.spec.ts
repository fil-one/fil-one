import { test, expect } from './fixtures.ts';
import { homeOrgOf, resetToHomeOrg, userIdOf } from './org.util.ts';
import {
  deleteInvitationsFor,
  readOrgName,
  runCleanup,
  seedInvitation,
  type SeededInvitation,
} from '../destructive/invite.util.ts';
import { STORAGE_STATE, byName, credential, switcherNames } from './users.util.ts';

test.use({ storageState: STORAGE_STATE.member });

let memberId: string;
let invitation: SeededInvitation;
let hostOrgId: string;
let hostOrgName: string;
let homeOrgName: string;

test.beforeAll(async () => {
  const ownerId = await userIdOf('owner');
  memberId = await userIdOf('member');
  await resetToHomeOrg(memberId);
  hostOrgId = await homeOrgOf(ownerId);
  [hostOrgName, homeOrgName] = await Promise.all([
    readOrgName(hostOrgId),
    homeOrgOf(memberId).then(readOrgName),
  ]);
  invitation = await seedInvitation({
    orgId: hostOrgId,
    email: credential('member', 'EMAIL'),
    role: 'member',
    invitedBy: ownerId,
  });
});

test.afterAll(async () => {
  await runCleanup([
    { label: 'memberships', run: () => resetToHomeOrg(memberId) },
    {
      label: 'invitation',
      run: () => deleteInvitationsFor({ orgId: hostOrgId, email: invitation.email }),
    },
  ]);
});

test('a member accepts an invitation and has both orgs in the switcher', async ({ page }) => {
  await page.goto(`/invite/accept#token=${encodeURIComponent(invitation.token)}`);
  await expect(page.getByTestId('accept-success')).toContainText(`Welcome to ${hostOrgName}`);

  await page.locator('#accept-continue-button').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByTestId('org-switcher-button').click();
  await expect(page.getByTestId('org-switcher')).toBeVisible();
  expect(await switcherNames(page)).toEqual(byName([hostOrgName, homeOrgName]));
});
