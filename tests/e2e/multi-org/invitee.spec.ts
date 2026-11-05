import { test, expect, api, type Page } from './fixtures.ts';
import { forgetAccount, homeOrgOf, membershipsOf, userIdOf } from './org.util.ts';
import {
  deleteInvitationsFor,
  readOrgName,
  runCleanup,
  seedInvitation,
} from '../destructive/invite.util.ts';
import { STORAGE_STATE, credential, menuItem } from './users.util.ts';

// A person whose first visit is an invitation link joins only the org that
// invited them (FIL-1651). Before, their first request created a personal org
// they never asked for, and removal from the team org later sent them to
// create yet another one.
//
// Auth0 cannot mint a user from a test, so the fresh account stands in for a
// brand-new sign-up: its console rows are deleted, and its session's next
// request is a first one. It is put back as a fresh sign-up afterwards, which
// is the state naming.spec.ts expects.

test.describe.configure({ mode: 'serial' });
test.use({ storageState: STORAGE_STATE.fresh });

const OWN_ORG_NAME = 'E2E Invitee Own Org';

let ownerId: string;
let ownerOrg: string;
let ownerOrgName: string;

test.beforeAll(async () => {
  ownerId = await userIdOf('owner');
  ownerOrg = await homeOrgOf(ownerId);
  ownerOrgName = await readOrgName(ownerOrg);
});

test.afterAll(async ({ browser }) => {
  await runCleanup([
    {
      label: 'invitations',
      run: () => deleteInvitationsFor({ orgId: ownerOrg, email: credential('fresh', 'EMAIL') }),
    },
    { label: 'invitee account', run: () => forgetAccount('fresh') },
    {
      label: 'fresh sign-up',
      run: async () => {
        // The console's first /me creates the account as a sign-up would.
        const context = await browser.newContext({ storageState: STORAGE_STATE.fresh });
        try {
          expect((await api(await context.newPage(), 'GET', '/api/me')).status()).toBe(200);
        } finally {
          await context.close();
        }
      },
    },
  ]);
});

/** Forget the fresh account, then send it through an invitation to the owner's org. */
async function acceptAsNewAccount(page: Page): Promise<string> {
  await forgetAccount('fresh');
  const invitation = await seedInvitation({
    orgId: ownerOrg,
    email: credential('fresh', 'EMAIL'),
    role: 'member',
    invitedBy: ownerId,
  });
  await page.goto(`/invite/accept#token=${encodeURIComponent(invitation.token)}`);
  await expect(page.getByTestId('accept-success')).toContainText(`Welcome to ${ownerOrgName}`);
  return await userIdOf('fresh');
}

/** The owner removes the invitee from the owner's org. */
async function removeFromOwnerOrg(page: Page, inviteeId: string): Promise<void> {
  const context = await page.context().browser()!.newContext({
    storageState: STORAGE_STATE.owner,
  });
  try {
    const response = await api(await context.newPage(), 'DELETE', `/api/org/members/${inviteeId}`);
    expect(response.status(), await response.text()).toBe(200);
  } finally {
    await context.close();
  }
}

test('a new account that accepts an invitation belongs only to the inviting org', async ({
  page,
}) => {
  const inviteeId = await acceptAsNewAccount(page);
  await page.locator('#accept-continue-button').click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('org-switcher-button')).toContainText(ownerOrgName);
  // The menu lists orgs to switch to only when there is more than one.
  await page.getByTestId('org-switcher-button').click();
  await expect(menuItem(page, 'Create organization')).toBeVisible();
  await expect(page.getByTestId('org-switcher')).toHaveCount(0);
  expect(await membershipsOf(inviteeId)).toStrictEqual([ownerOrg]);
  expect(await homeOrgOf(inviteeId)).toBe(ownerOrg);
});

test('an invitee removed from their only org lands on /left-organization', async ({ page }) => {
  const inviteeId = await acceptAsNewAccount(page);

  await removeFromOwnerOrg(page, inviteeId);
  await page.goto('/dashboard');

  await expect(page).toHaveURL(/\/left-organization$/);
});

test('an invitee who created their own org lands in it when removed from the inviting org', async ({
  page,
}) => {
  const inviteeId = await acceptAsNewAccount(page);
  const created = await api(page, 'POST', '/api/org', { name: OWN_ORG_NAME });
  expect(created.status(), await created.text()).toBe(201);
  const { orgId: ownOrg } = (await created.json()) as { orgId: string };

  await removeFromOwnerOrg(page, inviteeId);
  await page.goto('/dashboard');

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('org-switcher-button')).toContainText(OWN_ORG_NAME);
  expect(await homeOrgOf(inviteeId)).toBe(ownOrg);
});
